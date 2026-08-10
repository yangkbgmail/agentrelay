// Pure decision logic for `agentrelay drain` — block a script until the *whole*
// queue is caught up (no active jobs remain), then exit with a code that
// reflects how it settled. Where `wait <id>` follows a single job to its
// conclusion and `eta` reports *when* the queue will be caught up, `drain` bakes
// the poll loop in and blocks until that moment, so a caller can gate on the
// relay draining before moving on:
//
//   agentrelay run -- claude -p "big migration"   # may get rate-limited & queued
//   agentrelay drain --timeout 8h && ./deploy.sh   # deploy only once nothing is pending
//
// The polling loop (re-reading the store as a separate daemon/tick process
// advances jobs) lives in the CLI; everything here is a pure function of a job
// snapshot so the settle/outcome mapping is unit-testable without a clock, a
// store, or a spawned process.

import { ACTIVE_STATUSES } from "./stats.js";
import type { RelayJob } from "./types.js";

/**
 * How a `drain` ended. `drained` = the queue settled (no active jobs left).
 * `failed` = it settled but at least one job ended in `failed` and the caller
 * asked to treat that as an error (`--fail-on-error`). `timeout` = still had
 * active jobs when the deadline passed.
 */
export type DrainOutcome = "drained" | "failed" | "timeout";

/**
 * Exit code per outcome, so `agentrelay drain` composes in shell `&&`/`||`
 * chains and CI steps without parsing output. `timeout` uses 124 to match GNU
 * coreutils `timeout(1)` (and `wait`'s convention), a value scripters already
 * branch on.
 */
export const DRAIN_EXIT_CODES: Record<DrainOutcome, number> = {
  drained: 0,
  failed: 1,
  timeout: 124,
};

/** Map an outcome to its exit code. */
export function drainExitCode(outcome: DrainOutcome): number {
  return DRAIN_EXIT_CODES[outcome];
}

/**
 * A count of where the queue stands right now: how many jobs are still active
 * (the relay is or will be working them) versus settled into each terminal
 * state. `active === 0` is exactly the drained condition.
 */
export interface DrainSnapshot {
  /** Total jobs in scope. */
  total: number;
  /** queued + waiting_for_reset + resuming — the jobs keeping the queue open. */
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
}

const ACTIVE_SET = new Set<string>(ACTIVE_STATUSES);

/**
 * Bucket the jobs by whether they are still active or have settled terminally.
 * Pure and total: ACTIVE_STATUSES ∪ TERMINAL_STATUSES covers every JobStatus,
 * so every job lands in exactly one bucket.
 */
export function summarizeDrain(jobs: RelayJob[]): DrainSnapshot {
  const snapshot: DrainSnapshot = { total: jobs.length, active: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const job of jobs) {
    if (ACTIVE_SET.has(job.status)) {
      snapshot.active += 1;
    } else if (job.status === "completed") {
      snapshot.completed += 1;
    } else if (job.status === "failed") {
      snapshot.failed += 1;
    } else if (job.status === "cancelled") {
      snapshot.cancelled += 1;
    }
  }
  return snapshot;
}

/** True once no job is active — the queue has drained (nothing left to wait on). */
export function isQueueDrained(jobs: RelayJob[]): boolean {
  return jobs.every((job) => !ACTIVE_SET.has(job.status));
}

/**
 * Decide, from the queue's current snapshot, whether the drain is over. Returns
 * `done: false` while any job is still active; `done: true` with an `outcome`
 * once the queue settles. When settled, the outcome is `failed` if
 * `failOnError` is set and at least one job ended in `failed` (cancelled — a
 * user action — is never treated as a failure), otherwise `drained`. Pure: the
 * caller supplies the snapshot and owns the timeout clock.
 */
export function evaluateDrain(
  jobs: RelayJob[],
  options: { failOnError?: boolean } = {}
): { done: boolean; outcome?: DrainOutcome; snapshot: DrainSnapshot } {
  const snapshot = summarizeDrain(jobs);
  if (snapshot.active > 0) return { done: false, snapshot };
  const outcome: DrainOutcome = options.failOnError && snapshot.failed > 0 ? "failed" : "drained";
  return { done: true, outcome, snapshot };
}
