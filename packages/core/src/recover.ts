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
 * The *other* silent-failure class `recover` heals: jobs parked in
 * `waiting_for_reset` with a `resetAt` so far in the future they've almost
 * certainly misparsed (a bad epoch unit, a huge relative duration, a false
 * timezone read). `listDue` only resumes a parked job once `resetAt <= now`, so
 * a reset years out strands the job forever — no tick ever picks it up.
 *
 * The parser's reset-horizon guard (session 72) stops *new* misparses from being
 * queued, and `doctor`'s `reset-horizon` check (session 73) + the dashboard card
 * (session 74) *surface* jobs already parked far out — but until now the only fix
 * was to `cancel`/`retry` each one by id. This is the pure detection half of
 * reclaiming them in bulk, mirroring {@link selectStuckResumingJobs}: the queue
 * mutation and the clock live in the CLI.
 */
export interface FarFutureParkedOptions {
  /** Reference "now" (epoch ms) the horizon is measured from. */
  nowMs: number;
  /**
   * The plausibility horizon (ms). A parked job whose `resetAt` sits beyond
   * `now + horizonMs` is treated as misparsed. A non-positive / non-finite
   * `horizonMs` (or `null`) means the guard is disabled — nothing is far-future,
   * matching {@link isPlausibleReset}'s "no guard" semantics.
   */
  horizonMs: number | null;
}

export interface FarFutureParkedReport {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Jobs currently parked in `waiting_for_reset`, before the horizon test. */
  waiting: number;
  /** The horizon applied (ms), or `null` when the guard is disabled. */
  horizonMs: number | null;
  /**
   * The parked jobs whose `resetAt` is beyond the horizon — ordered
   * soonest-reset first (least extreme, most likely a genuine near-miss edge
   * case) so a caller reclaiming or listing them leads with the recoverable end,
   * matching how `doctor`/the dashboard pick the earliest as the example.
   */
  parked: RelayJob[];
}

/** Epoch ms of a job's `resetAt`, or NaN when missing/unparseable. */
function resetMs(job: RelayJob): number {
  return job.resetAt ? Date.parse(job.resetAt) : Number.NaN;
}

/**
 * Identify jobs parked far past the plausibility horizon. Pure and non-mutating.
 *
 * Only `waiting_for_reset` jobs are considered: that's the precise stranded
 * class. A `resuming` job's far-future `resetAt` is moot (the default
 * stuck-resuming path reclaims it), and a `queued` job is already due now
 * regardless of `resetAt`, so neither is stranded the way a parked job is.
 * Jobs with no `resetAt` or an unparseable one are skipped — there's nothing to
 * judge. When the guard is disabled the parked list is empty.
 */
export function selectFarFutureParkedJobs(jobs: RelayJob[], options: FarFutureParkedOptions): FarFutureParkedReport {
  const { nowMs, horizonMs } = options;
  const now = new Date(nowMs);

  let waiting = 0;
  const parked: Array<{ job: RelayJob; ms: number }> = [];
  for (const job of jobs) {
    if (job.status !== "waiting_for_reset") continue;
    waiting += 1;
    const ms = resetMs(job);
    if (Number.isNaN(ms)) continue;
    // `isPlausibleReset` bounds only the future side, so past/near resets pass
    // and only the far ones fall through here. A disabled guard makes every
    // reset plausible → nothing is far-future.
    if (!isPlausibleReset(new Date(ms), now, horizonMs)) {
      parked.push({ job, ms });
    }
  }

  // Soonest-reset first: smaller `resetAt` ms = closer to now = least extreme.
  // Tie-break on id for a deterministic order.
  parked.sort((a, b) => a.ms - b.ms || a.job.id.localeCompare(b.job.id));

  return {
    total: jobs.length,
    waiting,
    horizonMs: horizonMs !== null && Number.isFinite(horizonMs) && horizonMs > 0 ? horizonMs : null,
    parked: parked.map((entry) => entry.job),
  };
}
