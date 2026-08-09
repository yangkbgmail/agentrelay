// Pure decision logic for `agentrelay drain` — block a script until the *whole*
// queue (or a scoped subset) is caught up: no jobs left in an active state
// (queued / waiting_for_reset / resuming). Where `wait <id>` follows one job to
// its conclusion and `eta` reports a non-blocking countdown to the latest reset,
// `drain` is the blocking, fleet-level composition of the two — "hold here until
// the relay has nothing left to resume, then tell me how it went":
//
//   agentrelay run -- claude -p "batch 1"   # may get rate-limited & queued
//   agentrelay run -- claude -p "batch 2"
//   agentrelay drain --fail-on-error && deploy   # deploy only if all finished ok
//
// The polling loop (re-reading the store as a separate daemon/tick process
// drains it) lives in the CLI; everything here is a pure function of a job
// snapshot so the decision and exit-code mapping are unit-testable without a
// clock, a store, or a spawned process.

import { ACTIVE_STATUSES } from "./stats.js";
import type { RelayJob } from "./types.js";

/**
 * A point-in-time count of where the (already scoped) jobs sit. `active` is the
 * number the relay still has to resume — drain is done when it reaches zero.
 * The three terminal counts describe how the drained jobs settled.
 */
export interface DrainSnapshot {
  /** Total jobs in scope. */
  total: number;
  /** Jobs still to resume: queued + waiting_for_reset + resuming. */
  active: number;
  /** Jobs that finished successfully. */
  completed: number;
  /** Jobs that exhausted retries or otherwise failed. */
  failed: number;
  /** Jobs a user cancelled. */
  cancelled: number;
}

/**
 * How a `drain` ended: `drained` (no active jobs remain) or `timeout` (the
 * deadline passed with jobs still active).
 */
export type DrainOutcome = "drained" | "timeout";

/**
 * Exit code per outcome so `agentrelay drain` composes in shell `&&`/`||` chains
 * and CI steps without parsing output. `timeout` uses 124 to match GNU
 * coreutils `timeout(1)` (and `agentrelay wait`), a convention scripters already
 * branch on.
 */
export const DRAIN_EXIT_CODES: Record<DrainOutcome, number> = {
  drained: 0,
  timeout: 124,
};

/** Count the scoped jobs by state into a {@link DrainSnapshot}. Pure. */
export function summarizeDrain(jobs: RelayJob[]): DrainSnapshot {
  let active = 0;
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  for (const job of jobs) {
    if (ACTIVE_STATUSES.includes(job.status)) active += 1;
    else if (job.status === "completed") completed += 1;
    else if (job.status === "failed") failed += 1;
    else if (job.status === "cancelled") cancelled += 1;
  }
  return { total: jobs.length, active, completed, failed, cancelled };
}

/**
 * Decide, from the jobs' current snapshot, whether the drain is over. Returns
 * `done: true` once no job is active — the relay has resumed everything it was
 * waiting on. Pure: the caller supplies the (already scoped) job list and owns
 * the timeout clock.
 */
export function evaluateDrain(jobs: RelayJob[]): { done: boolean; snapshot: DrainSnapshot } {
  const snapshot = summarizeDrain(jobs);
  return { done: snapshot.active === 0, snapshot };
}

/**
 * Map an outcome + final snapshot to an exit code. When `failOnError` is set, a
 * fully drained queue that still contains a `failed` job exits 1 — so a CI step
 * can gate on "everything relayed *and succeeded*". Without it, draining always
 * exits 0 regardless of individual job outcomes (the queue is simply caught up).
 * `timeout` always maps to 124.
 */
export function drainExitCode(outcome: DrainOutcome, snapshot: DrainSnapshot, failOnError = false): number {
  if (outcome === "timeout") return DRAIN_EXIT_CODES.timeout;
  if (failOnError && snapshot.failed > 0) return 1;
  return DRAIN_EXIT_CODES.drained;
}
