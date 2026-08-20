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

import { TERMINAL_STATUSES } from "./stats.js";
import type { JobStatus, RelayJob } from "./types.js";

/** Whether `status` is one a job never transitions out of. */
export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
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
 * Terminal-state breakdown of a *set* of tracked jobs, for `agentrelay wait
 * --all` — block a script until the whole active queue (or a scoped subset)
 * drains, then branch on the aggregate result. Where {@link evaluateWait}
 * follows one job, this reduces across many so a caller can gate on "everything
 * the relay was working has settled".
 */
export interface WaitAllTally {
  /** Tracked jobs still non-terminal and present (queued/waiting/resuming). */
  pending: number;
  /** Present jobs that reached `completed`. */
  completed: number;
  /** Present jobs that reached `failed`. */
  failed: number;
  /** Present jobs that reached `cancelled`. */
  cancelled: number;
  /** Tracked jobs no longer in the store (pruned/removed while waiting). */
  missing: number;
}

/**
 * Tally the current snapshots of a tracked set of jobs. Each entry is the
 * latest snapshot of one job we're waiting on, or `null` if it vanished from
 * the store mid-wait. Pure: the caller owns the polling loop and the timeout
 * clock, so the reduction stays unit-testable without I/O.
 */
export function tallyWaitAll(jobs: (RelayJob | null)[]): WaitAllTally {
  const tally: WaitAllTally = { pending: 0, completed: 0, failed: 0, cancelled: 0, missing: 0 };
  for (const job of jobs) {
    if (!job) {
      tally.missing += 1;
    } else if (!isTerminalStatus(job.status)) {
      tally.pending += 1;
    } else if (job.status === "completed") {
      tally.completed += 1;
    } else if (job.status === "failed") {
      tally.failed += 1;
    } else if (job.status === "cancelled") {
      tally.cancelled += 1;
    }
  }
  return tally;
}

/** True once no tracked job is still pending (every job settled or vanished). */
export function isWaitAllDone(tally: WaitAllTally): boolean {
  return tally.pending === 0;
}

/**
 * Aggregate exit code for `wait --all`, mirroring the single-job convention
 * ({@link WAIT_EXIT_CODES}) but reduced across the whole set: any failure → 1,
 * else any cancellation → 2, else 0 (drained cleanly). A `timedOut` pass with
 * jobs still pending → 124, matching GNU `timeout(1)`. A vanished (`missing`)
 * job is benign — one that completed and was then pruned shouldn't fail a gate —
 * so it never raises the code on its own.
 */
export function waitAllExitCode(tally: WaitAllTally, timedOut: boolean): number {
  if (timedOut && tally.pending > 0) return WAIT_EXIT_CODES.timeout;
  if (tally.failed > 0) return WAIT_EXIT_CODES.failed;
  if (tally.cancelled > 0) return WAIT_EXIT_CODES.cancelled;
  return WAIT_EXIT_CODES.completed;
}
