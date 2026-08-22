import { isPlausibleReset } from "./parser.js";
import type { RelayJob } from "./types.js";

/**
 * Recovery of jobs orphaned mid-resume.
 *
 * The scheduler resumes a job by first calling `markResuming` (status →
 * `resuming`, attempts bumped) and only later marking a terminal outcome
 * (`completed`/`failed`) or re-parking it (`waiting_for_reset`). If the process
 * dies in between — a daemon OOM-killed, a `SIGKILL`, a host reboot mid-run —
 * the job is left **stuck in `resuming` forever**:
 *
 * - `listDue` only returns `waiting_for_reset` jobs, so no future tick picks it
 *   up again;
 * - `agentrelay retry` refuses it (`canRequeue` rejects `resuming` to avoid
 *   racing a genuinely in-flight run).
 *
 * So the one job that most needed the relay silently never resumes. This module
 * is the *pure* half of the fix: given the job list and an injected `now`, it
 * decides which `resuming` jobs look orphaned (have sat in that state longer
 * than any live resume plausibly would). The queue mutation and the clock live
 * in the CLI, mirroring how `doctor`/`prune` split pure logic from I/O.
 */

/**
 * How long a job may sit in `resuming` before it's treated as orphaned. A live
 * resume writes a fresh `updatedAt` the instant it enters `resuming`, so a job
 * still marked `resuming` this long afterward almost certainly belongs to a
 * loop that died. 30 minutes is generous enough to clear even a slow agent run
 * while still catching a crash within a poll or two of the next daemon start.
 */
export const DEFAULT_STUCK_RESUMING_MS = 30 * 60_000;

export interface StuckResumingOptions {
  /** Reference "now" (epoch ms) the ages are measured against. */
  nowMs: number;
  /**
   * Minimum time (ms) a job must have been `resuming` to count as stuck.
   * Defaults to {@link DEFAULT_STUCK_RESUMING_MS}. `0` selects every `resuming`
   * job regardless of age — the right choice when the operator *knows* the loop
   * is dead and wants to reclaim everything immediately.
   */
  stuckAfterMs?: number;
}

export interface StuckResumingReport {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Jobs currently in the `resuming` state, before the age threshold. */
  resuming: number;
  /** The staleness threshold applied (ms). */
  stuckAfterMs: number;
  /**
   * The `resuming` jobs judged orphaned — old enough (or with an unusable
   * `updatedAt`) to reclaim — ordered oldest-stuck first, so a caller reclaiming
   * or listing them addresses the longest-waiting job before the rest.
   */
  stuck: RelayJob[];
}

/** Epoch ms of an ISO timestamp, or NaN when missing/unparseable. */
function updatedMs(iso: string): number {
  return Date.parse(iso);
}

/**
 * Identify jobs stuck in `resuming` past the staleness threshold. Pure and
 * non-mutating.
 *
 * A `resuming` job whose `updatedAt` can't be parsed is treated as stuck: a loop
 * actively running the job always writes a valid, fresh timestamp, so an
 * unparseable one can only come from a store no live loop is maintaining — safe
 * to reclaim rather than strand forever.
 */
export function selectStuckResumingJobs(jobs: RelayJob[], options: StuckResumingOptions): StuckResumingReport {
  const stuckAfterMs =
    options.stuckAfterMs !== undefined ? Math.max(0, options.stuckAfterMs) : DEFAULT_STUCK_RESUMING_MS;
  const { nowMs } = options;

  let resuming = 0;
  const stuck: Array<{ job: RelayJob; ageKey: number }> = [];
  for (const job of jobs) {
    if (job.status !== "resuming") continue;
    resuming += 1;
    const ms = updatedMs(job.updatedAt);
    // Unparseable timestamp → treat as infinitely old (definitely not a live run).
    const age = Number.isNaN(ms) ? Number.POSITIVE_INFINITY : nowMs - ms;
    if (age >= stuckAfterMs) {
      stuck.push({ job, ageKey: Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms });
    }
  }

  // Oldest-stuck first: smaller `updatedAt` ms = longer waiting. Unparseable
  // timestamps (ageKey -Infinity) sort first as the most suspect.
  stuck.sort((a, b) => a.ageKey - b.ageKey);

  return {
    total: jobs.length,
    resuming,
    stuckAfterMs,
    stuck: stuck.map((entry) => entry.job),
  };
}

/**
 * The *second* silent-failure class `recover` can reclaim: a job parked in
 * `waiting_for_reset` with an implausibly **far-future** `resetAt`.
 *
 * A misparse (wrong epoch units, a huge relative span, a mis-detected timezone),
 * or a job queued back when the parser's plausibility guard was off, can leave a
 * job waiting days or years for a reset that will never come — the scheduler's
 * `listDue` only fires once `resetAt` passes, so the job sits stranded and
 * silently never resumes. `doctor`'s `reset-horizon` check and the dashboard both
 * *surface* these jobs; this selector is the pure half of *reclaiming* them, so
 * the same horizon that flags them also drives the fix (no drift). It shares
 * {@link isPlausibleReset} — the exact predicate `doctor` and the parser guard
 * use — so a job flagged in one place is judged identically here.
 */
export interface FarFutureParkedOptions {
  /** Reference "now" (epoch ms) the resets are measured against. */
  nowMs: number;
  /**
   * The plausibility horizon (ms into the future): a parked job whose `resetAt`
   * lies beyond `now + horizonMs` is judged misparsed and eligible to reclaim.
   * A non-positive / non-finite / `null` horizon means "guard disabled" and
   * selects nothing, mirroring {@link isPlausibleReset}'s "no guard" semantics
   * (so `AGENTRELAY_MAX_RESET_HORIZON=off` reclaims nothing rather than
   * everything).
   */
  horizonMs: number | null;
}

export interface FarFutureParkedReport {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Jobs currently parked in `waiting_for_reset`, before the horizon filter. */
  parked: number;
  /** The horizon applied (ms), or `null` when the guard is disabled. */
  horizonMs: number | null;
  /**
   * The parked jobs whose `resetAt` sits beyond the horizon — ordered
   * furthest-reset first, so the most extreme (most-certainly misparsed) job
   * leads the list a caller reclaims or prints.
   */
  farFuture: RelayJob[];
}

/**
 * Identify jobs parked in `waiting_for_reset` with a reset beyond the horizon.
 * Pure and non-mutating. Only `waiting_for_reset` jobs qualify: a `queued` job is
 * already due (its `resetAt` isn't acted on), and a `resuming` job belongs to the
 * stuck-resuming path ({@link selectStuckResumingJobs}). Jobs with no `resetAt`
 * or an unparseable one are skipped (nothing to judge). A past/near reset is fine
 * — {@link isPlausibleReset} bounds only the future side.
 */
export function selectFarFutureParkedJobs(jobs: RelayJob[], options: FarFutureParkedOptions): FarFutureParkedReport {
  const { nowMs, horizonMs } = options;
  const guardOff = horizonMs == null || !Number.isFinite(horizonMs) || horizonMs <= 0;
  const now = new Date(nowMs);

  let parked = 0;
  const hits: Array<{ job: RelayJob; resetMs: number }> = [];
  for (const job of jobs) {
    if (job.status !== "waiting_for_reset") continue;
    parked += 1;
    if (guardOff) continue;
    if (!job.resetAt) continue;
    const resetMs = Date.parse(job.resetAt);
    if (Number.isNaN(resetMs)) continue;
    if (!isPlausibleReset(new Date(resetMs), now, horizonMs)) {
      hits.push({ job, resetMs });
    }
  }

  // Furthest reset first — the most extreme misparse leads.
  hits.sort((a, b) => b.resetMs - a.resetMs);

  return {
    total: jobs.length,
    parked,
    horizonMs: guardOff ? null : horizonMs,
    farFuture: hits.map((entry) => entry.job),
  };
}
