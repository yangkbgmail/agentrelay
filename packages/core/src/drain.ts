// Pure decision logic for `agentrelay drain` — block a script until the whole
// queue (or a scoped subset) has no jobs left that the relay is still working,
// then exit with a code reflecting the aggregate outcome. Where `wait <id>`
// follows a *single* job to its conclusion, `drain` follows the *fleet*: a CI
// step can queue several relayed jobs and then block until they've all settled
// before moving on.
//
//   agentrelay run -- claude -p "migrate service A" &
//   agentrelay run -- claude -p "migrate service B" &
//   agentrelay drain --timeout 6h && deploy   # deploy only once nothing is pending
//
// The polling loop (re-reading the store as a separate daemon/tick process
// advances the jobs) lives in the CLI; everything here is a pure function of a
// jobs snapshot so the aggregate outcome and its exit code are unit-testable
// without a clock, a store, or spawned processes.

import { ACTIVE_STATUSES } from "./stats.js";
import { summarizeJobs } from "./summary.js";
import type { RelayJob } from "./types.js";

/**
 * How a `drain` ended, in the order of severity used for the aggregate exit
 * code. `empty` means nothing in scope was ever active (nothing to wait for);
 * `completed` means every scoped job finished cleanly; `failed`/`cancelled`
 * mean at least one scoped terminal job failed / was cancelled; `timeout` means
 * the deadline passed while jobs were still active.
 */
export type DrainOutcome = "empty" | "completed" | "failed" | "cancelled" | "timeout";

/**
 * Exit code per outcome, so `agentrelay drain` composes in shell `&&`/`||`
 * chains and CI steps without parsing output. `timeout` uses 124 to match GNU
 * coreutils `timeout(1)`, mirroring `wait`. `empty` and `completed` both exit 0
 * — either way, nothing is left pending and nothing failed.
 */
export const DRAIN_EXIT_CODES: Record<DrainOutcome, number> = {
  empty: 0,
  completed: 0,
  failed: 1,
  cancelled: 2,
  timeout: 124,
};

/** Map an outcome to its exit code. */
export function drainExitCode(outcome: DrainOutcome): number {
  return DRAIN_EXIT_CODES[outcome];
}

/**
 * A point-in-time count of the scoped jobs by disposition. `active` is the sum
 * of jobs the relay is still working (queued/waiting_for_reset/resuming); the
 * drain is over once it reaches 0.
 */
export interface DrainSnapshot {
  /** Jobs in scope, total. */
  total: number;
  /** Still queued / waiting_for_reset / resuming. */
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
}

/** Count the scoped jobs by disposition. Pure; input is not mutated. */
export function summarizeDrain(jobs: RelayJob[]): DrainSnapshot {
  const byStatus = summarizeJobs(jobs).byStatus;
  const active = ACTIVE_STATUSES.reduce((sum, s) => sum + byStatus[s], 0);
  return {
    total: jobs.length,
    active,
    completed: byStatus.completed,
    failed: byStatus.failed,
    cancelled: byStatus.cancelled,
  };
}

/**
 * Reduce a settled snapshot (no active jobs) to a single aggregate outcome.
 * Precedence is failure-first: any failed job makes the whole drain `failed`,
 * then any cancelled makes it `cancelled`, otherwise `completed`. A snapshot
 * with no jobs at all is `empty`. Assumes `snapshot.active === 0`.
 */
function settledOutcome(snapshot: DrainSnapshot): DrainOutcome {
  if (snapshot.total === 0) return "empty";
  if (snapshot.failed > 0) return "failed";
  if (snapshot.cancelled > 0) return "cancelled";
  return "completed";
}

/**
 * Decide, from the scoped jobs' current snapshot, whether the drain is over.
 * Returns `done: false` while any job is still active; `done: true` with the
 * aggregate `outcome` once the queue has drained (or was empty to begin with).
 * Pure: the caller supplies the snapshot and owns the timeout clock.
 */
export function evaluateDrain(jobs: RelayJob[]): {
  done: boolean;
  outcome?: DrainOutcome;
  snapshot: DrainSnapshot;
} {
  const snapshot = summarizeDrain(jobs);
  if (snapshot.active > 0) return { done: false, snapshot };
  return { done: true, outcome: settledOutcome(snapshot), snapshot };
}
