// Pure decision logic for `agentrelay waitall` — block a script until the
// *entire* queue (or a scoped subset) has drained to terminal state, then exit
// with a code that reflects the batch result. Where `wait <id>` follows one job
// to its conclusion, `waitall` is the fleet-level barrier: fan out a batch of
// rate-limit-prone jobs, then gate the next CI step on all of them settling:
//
//   for p in "$@"; do agentrelay run --project batch -- claude -p "$p"; done
//   agentrelay waitall --project batch --timeout 8h && ./publish.sh
//
// The polling loop (re-reading the store as separate daemon/tick processes
// advance jobs) lives in the CLI; everything here is a pure function of a job
// snapshot list so the outcome mapping is unit-testable without a clock, a
// store, or spawned processes.

import { ACTIVE_STATUSES } from "./stats.js";
import type { JobStatus, RelayJob } from "./types.js";

/** Whether `status` is one a job can still transition out of (not terminal). */
export function isActiveStatus(status: JobStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/**
 * A snapshot of how far a batch has drained. `active` counts jobs still
 * queued/waiting_for_reset/resuming; the terminal buckets are disjoint from it
 * and from each other, so `active + completed + failed + cancelled === total`.
 * `done` is simply "nothing left in flight".
 */
export interface WaitAllProgress {
  /** Jobs in scope. */
  total: number;
  /** Still queued / waiting_for_reset / resuming. */
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** True once no job in scope is still active. */
  done: boolean;
}

/**
 * How a `waitall` ended, in outcome (not exit-code) terms:
 * - `empty`         — nothing in scope to wait for
 * - `all-completed` — every job settled and all of them completed
 * - `some-failed`   — the batch drained but at least one job failed
 * - `some-cancelled`— drained, none failed, but at least one was cancelled
 * - `timeout`       — the deadline passed while jobs were still active
 */
export type WaitAllOutcome = "empty" | "all-completed" | "some-failed" | "some-cancelled" | "timeout";

/**
 * Exit code per outcome so `agentrelay waitall` composes in shell `&&`/`||`
 * chains and CI steps without parsing output. Precedence when settled mirrors
 * single-job `wait`: any failure dominates (1), then any cancellation (2),
 * otherwise success (0). `timeout` uses 124 to match GNU coreutils `timeout(1)`.
 */
export const WAITALL_EXIT_CODES: Record<WaitAllOutcome, number> = {
  empty: 0,
  "all-completed": 0,
  "some-failed": 1,
  "some-cancelled": 2,
  timeout: 124,
};

/** Map an outcome to its exit code. */
export function waitAllExitCode(outcome: WaitAllOutcome): number {
  return WAITALL_EXIT_CODES[outcome];
}

/**
 * Tally a job list into a {@link WaitAllProgress}. Pure and non-mutating — the
 * caller supplies the (already-scoped) snapshot each poll. Any status outside
 * the four known terminal/active buckets simply doesn't increment a bucket, but
 * still counts toward `total`; such a job also keeps `done` honest only if it's
 * one of the active statuses (unknown statuses are treated as not-active so a
 * corrupt record can't wedge the loop forever).
 */
export function summarizeWaitAll(jobs: RelayJob[]): WaitAllProgress {
  let active = 0;
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  for (const job of jobs) {
    if (isActiveStatus(job.status)) active += 1;
    else if (job.status === "completed") completed += 1;
    else if (job.status === "failed") failed += 1;
    else if (job.status === "cancelled") cancelled += 1;
  }
  return { total: jobs.length, active, completed, failed, cancelled, done: active === 0 };
}

/**
 * Resolve a batch's final outcome from its progress plus whether the deadline
 * has passed. Kept separate from {@link summarizeWaitAll} so the exit-code
 * mapping is a pure function of two small inputs. Precedence once settled:
 * failed > cancelled > completed. A deadline that lands exactly as the batch
 * finishes (`timedOut` true but `done` true) reports the real outcome, not a
 * spurious timeout.
 */
export function resolveWaitAllOutcome(progress: WaitAllProgress, timedOut: boolean): WaitAllOutcome {
  if (progress.total === 0) return "empty";
  if (timedOut && !progress.done) return "timeout";
  if (progress.failed > 0) return "some-failed";
  if (progress.cancelled > 0) return "some-cancelled";
  return "all-completed";
}
