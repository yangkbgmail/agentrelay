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
 * The second silent-failure class `recover` can reclaim: jobs parked in
 * `waiting_for_reset` with a `resetAt` so far in the future they'll never come
 * due in a sane window. The parser's horizon guard (see {@link isPlausibleReset})
 * only vets *newly parsed* rate-limits, so a job queued before the guard existed,
 * while it was disabled, or by a misparse that slipped a wrong epoch unit / huge
 * relative span through can sit `waiting_for_reset` for days or years — `listDue`
 * never returns it (its `resetAt` isn't due) and `retry` would have to be run by
 * hand per id. `doctor`'s reset-horizon check and the dashboard card only *warn*
 * about these; this is the pure half of the one-command *fix*.
 */
export interface FarFutureParkedOptions {
  /** Reference "now" (epoch ms) the reset distances are measured against. */
  nowMs: number;
  /**
   * The plausibility horizon (ms): a parked job whose `resetAt` is more than this
   * far ahead of `nowMs` is judged misparsed. `null` (or any non-positive /
   * non-finite value) means the guard is disabled — no job is flagged, mirroring
   * {@link isPlausibleReset}'s "no guard" semantics.
   */
  horizonMs: number | null;
}

export interface FarFutureParkedReport {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Jobs currently `waiting_for_reset` with a parseable `resetAt` (the pool the horizon is applied to). */
  parked: number;
  /** The horizon (ms) applied, or `null` when the guard is disabled. */
  horizonMs: number | null;
  /**
   * The parked jobs whose `resetAt` lies beyond the horizon, ordered
   * earliest-reset first — the least-extreme (most likely a real edge case, and
   * soonest to matter) job leads, matching how `doctor` and the dashboard list
   * them.
   */
  farFuture: RelayJob[];
}

/**
 * Identify `waiting_for_reset` jobs parked with an implausibly-distant `resetAt`.
 * Pure and non-mutating.
 *
 * Only `waiting_for_reset` jobs are candidates — a `queued` job runs on the next
 * tick regardless of `resetAt`, and a `resuming` job is either genuinely in
 * flight or already covered by {@link selectStuckResumingJobs}. A job with no
 * `resetAt` or an unparseable one is skipped (nothing to judge). When the guard
 * is disabled (`horizonMs` null/non-positive/non-finite) the pool is still
 * counted but `farFuture` is empty.
 */
export function selectFarFutureParkedJobs(jobs: RelayJob[], options: FarFutureParkedOptions): FarFutureParkedReport {
  const { nowMs, horizonMs } = options;
  const now = new Date(nowMs);

  let parked = 0;
  const farFuture: Array<{ job: RelayJob; resetMs: number }> = [];
  for (const job of jobs) {
    if (job.status !== "waiting_for_reset") continue;
    if (!job.resetAt) continue;
    const resetMs = Date.parse(job.resetAt);
    if (Number.isNaN(resetMs)) continue;
    parked += 1;
    // `isPlausibleReset` bounds only the future side, so a past/near reset stays
    // plausible and only the far ones fall through here. A disabled guard makes
    // every reset plausible, leaving `farFuture` empty.
    if (!isPlausibleReset(new Date(resetMs), now, horizonMs)) {
      farFuture.push({ job, resetMs });
    }
  }

  // Earliest reset first: least extreme (soonest to matter) leads.
  farFuture.sort((a, b) => a.resetMs - b.resetMs);

  return {
    total: jobs.length,
    parked,
    horizonMs: horizonMs !== null && Number.isFinite(horizonMs) && horizonMs > 0 ? horizonMs : null,
    farFuture: farFuture.map((entry) => entry.job),
  };
}

/**
 * The third silent-failure class `recover` can reclaim: jobs parked in
 * `waiting_for_reset` with **no usable reset time at all** — `resetAt` is `null`
 * or a non-parseable string.
 *
 * These are strictly worse than a far-future reset: a far-future job at least
 * has a (wrong, distant) time, so `recover --far-future` can spot it. A stranded
 * job has none, so it is invisible to *every* time-based surface — `listDue`'s
 * `resetAt !== null && Date(resetAt) <= now` is false (a `NaN` comparison never
 * holds), and `next`/`upcoming`/`overdue` all filter out an unparseable/absent
 * `resetAt`. `selectFarFutureParkedJobs` also deliberately skips them (there is
 * no distance to judge). So the job sits `waiting_for_reset` forever with nothing
 * to resume it and nothing to even list it.
 *
 * `agentrelay verify` *warns* about exactly this shape (`waiting-without-reset` /
 * `unparseable-resetAt`) but can't fix it; this is the pure half of the
 * one-command fix, mirroring {@link selectFarFutureParkedJobs}.
 *
 * How does a job reach this state? Not through the normal parse→enqueue path
 * (which always writes a valid ISO reset), but through a hand-edited `jobs.json`,
 * a botched merge, an `import` of an older/newer dump, or a build that wrote the
 * field differently — the same "leaky cast" `verify` exists to catch.
 */
export interface StrandedResetReport {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Jobs currently `waiting_for_reset` (the pool the reset check is applied to). */
  waiting: number;
  /**
   * The `waiting_for_reset` jobs with no usable `resetAt` (null or unparseable),
   * ordered oldest-created first — the longest-stranded job leads, matching how
   * the other `recover` scans address the longest-waiting job first. Reset time
   * can't order them (there is none), so `createdAt` (then `id`) is the axis.
   */
  stranded: RelayJob[];
}

/**
 * Identify `waiting_for_reset` jobs stranded with no usable reset time. Pure and
 * non-mutating.
 *
 * A job counts as stranded when its `resetAt` is `null` or doesn't parse as a
 * date — either way no tick will ever pick it up. Only `waiting_for_reset` jobs
 * are candidates (a `queued` job runs next tick regardless; `resuming` is covered
 * by {@link selectStuckResumingJobs}; terminal jobs are done).
 */
export function selectStrandedResetJobs(jobs: RelayJob[]): StrandedResetReport {
  let waiting = 0;
  const stranded: Array<{ job: RelayJob; createdMs: number }> = [];
  for (const job of jobs) {
    if (job.status !== "waiting_for_reset") continue;
    waiting += 1;
    if (job.resetAt !== null && !Number.isNaN(Date.parse(job.resetAt))) continue;
    stranded.push({ job, createdMs: Date.parse(job.createdAt) });
  }

  // Oldest-created first. An unparseable `createdAt` (NaN) sorts first as the
  // most suspect record; ties break by id for a fully deterministic order.
  stranded.sort((a, b) => {
    const am = Number.isNaN(a.createdMs) ? Number.NEGATIVE_INFINITY : a.createdMs;
    const bm = Number.isNaN(b.createdMs) ? Number.NEGATIVE_INFINITY : b.createdMs;
    if (am !== bm) return am - bm;
    return a.job.id < b.job.id ? -1 : a.job.id > b.job.id ? 1 : 0;
  });

  return {
    total: jobs.length,
    waiting,
    stranded: stranded.map((entry) => entry.job),
  };
}
