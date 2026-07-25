// Pure decision logic for `agentrelay wait <id>` — block a script until a
// specific job reaches a terminal state, then exit with a code that reflects
// the outcome. Where `next` answers "what resumes next?" across the queue,
// `wait` follows one job to its conclusion, so a caller can chain on the
// relay's result:
//
//   agentrelay run -- claude -p "long refactor"   # may get rate-limited & queued
//   agentrelay wait <id> --timeout 6h && deploy    # runs deploy only if it finished
//
// The polling loop (re-reading the store as a separate daemon/tick process
// advances the job) lives in the CLI; everything here is a pure function of a
// job snapshot so the outcome mapping is unit-testable without a clock, a
// store, or a spawned process.

import { ACTIVE_STATUSES, TERMINAL_STATUSES } from "./stats.js";
import type { JobStatus, RelayJob } from "./types.js";

/** Whether `status` is one a job never transitions out of. */
export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Whether `status` is one a job can still transition out of (queued/waiting/resuming). */
export function isActiveStatus(status: JobStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/**
 * How a `wait` ended. The three terminal job states plus two loop endings:
 * `timeout` (still pending when the deadline passed) and `missing` (the job
 * vanished from the store mid-wait, e.g. pruned by an aggressive auto-prune).
 */
export type WaitOutcome = "completed" | "failed" | "cancelled" | "timeout" | "missing";

/**
 * Exit code per outcome, so `agentrelay wait <id>` composes in shell `&&`/`||`
 * chains and CI steps without parsing output. `timeout` uses 124 to match GNU
 * coreutils `timeout(1)`, a convention scripters already branch on.
 */
export const WAIT_EXIT_CODES: Record<WaitOutcome, number> = {
  completed: 0,
  failed: 1,
  cancelled: 2,
  timeout: 124,
  missing: 5,
};

/** Map an outcome to its exit code. */
export function waitExitCode(outcome: WaitOutcome): number {
  return WAIT_EXIT_CODES[outcome];
}

/**
 * Decide, from the job's current snapshot, whether the wait is over. Returns
 * `done: false` while the job is still queued/waiting/resuming; `done: true`
 * with the terminal `outcome` once it settles. A `null` job means it's no
 * longer in the store (`missing`). Pure: the caller supplies the snapshot and
 * owns the timeout clock.
 */
export function evaluateWait(job: RelayJob | null): { done: boolean; outcome?: WaitOutcome } {
  if (!job) return { done: true, outcome: "missing" };
  if (isTerminalStatus(job.status)) return { done: true, outcome: job.status as WaitOutcome };
  return { done: false };
}

/**
 * Severity ranking so `wait --all` can collapse a set of per-job outcomes into
 * one aggregate: the batch's result is its *worst* member. Higher = worse.
 * `timeout` tops the list because a batch that didn't finish in time is the most
 * actionable failure; `completed` is the only "all-clear". Kept as a total order
 * over every {@link WaitOutcome} so the aggregate is always defined.
 */
export const WAIT_OUTCOME_SEVERITY: Record<WaitOutcome, number> = {
  timeout: 4,
  failed: 3,
  cancelled: 2,
  missing: 1,
  completed: 0,
};

/**
 * Fold a set of per-job outcomes into the single worst one (see
 * {@link WAIT_OUTCOME_SEVERITY}), so `agentrelay wait --all` exits with a code
 * that reflects the batch as a whole. An empty set means "nothing was pending",
 * which is a success (`completed`). Pure.
 */
export function aggregateWaitOutcomes(outcomes: WaitOutcome[]): WaitOutcome {
  let worst: WaitOutcome = "completed";
  for (const outcome of outcomes) {
    if (WAIT_OUTCOME_SEVERITY[outcome] > WAIT_OUTCOME_SEVERITY[worst]) worst = outcome;
  }
  return worst;
}

/** The verdict of a `wait --all` poll: are all tracked jobs settled yet? */
export interface WaitAllVerdict {
  /** True once every tracked job is terminal or missing. */
  done: boolean;
  /** Per-tracked-job outcomes, populated only when `done` (empty while pending). */
  outcomes: WaitOutcome[];
  /** How many tracked jobs are still non-terminal (for progress output). */
  pending: number;
}

/**
 * Decide whether a *batch* wait is over from the current snapshots of the
 * tracked jobs. `snapshots` is one entry per originally-tracked id, in the same
 * order, where `null` marks a job that has vanished from the store (`missing`,
 * e.g. pruned mid-wait). The wait is done only when none are still active; until
 * then `outcomes` is empty so a caller can't act on a partial batch. Pure — the
 * caller owns the id set, the store reads, and the timeout clock.
 */
export function evaluateWaitAll(snapshots: (RelayJob | null)[]): WaitAllVerdict {
  let pending = 0;
  const outcomes: WaitOutcome[] = [];
  for (const job of snapshots) {
    if (!job) {
      outcomes.push("missing");
      continue;
    }
    if (isTerminalStatus(job.status)) {
      outcomes.push(job.status as WaitOutcome);
      continue;
    }
    pending += 1;
  }
  if (pending > 0) return { done: false, outcomes: [], pending };
  return { done: true, outcomes, pending: 0 };
}
