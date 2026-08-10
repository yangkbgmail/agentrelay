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
 * Snapshot verdict for `agentrelay wait --all`: has a (already scope-filtered)
 * job list fully drained? Where {@link evaluateWait} follows a single job to its
 * conclusion, this watches the whole queue empty out — the condition `wait --all`
 * blocks on so a script can start the daemon, wait for every job to settle, then
 * proceed:
 *
 *   agentrelay daemon &                 # keep resuming jobs as their limits reset
 *   agentrelay wait --all --timeout 8h  # block until nothing active remains
 *   ./deploy.sh                         # runs once the queue is caught up
 */
export interface QueueDrainState {
  /** Jobs still in a non-terminal (active) state: queued/waiting_for_reset/resuming. */
  active: number;
  /** True when no active jobs remain — the queue is drained. */
  done: boolean;
}

/**
 * Decide whether a job list has fully drained: no job remains in a non-terminal
 * (active) state. Terminal jobs (completed/failed/cancelled) don't count — a
 * queue full of finished jobs is drained. The caller passes an already
 * scope-filtered list, so `wait --all --project foo` can drain just one
 * project's jobs. Pure: no clock, no store, no loop — those live in the CLI.
 */
export function evaluateWaitAll(jobs: RelayJob[]): QueueDrainState {
  let active = 0;
  for (const job of jobs) {
    if (!isTerminalStatus(job.status)) active += 1;
  }
  return { active, done: active === 0 };
}

/**
 * How a `wait --all` ended: the queue drained, or the deadline passed with jobs
 * still active. Kept separate from {@link WaitOutcome} (which is per-job) so the
 * two exit-code tables can't drift into each other.
 */
export type WaitAllOutcome = "drained" | "timeout";

/**
 * Exit code per `wait --all` outcome. `drained` is success (0); `timeout` reuses
 * 124 (GNU coreutils `timeout(1)`), matching the per-job {@link WAIT_EXIT_CODES}
 * so scripts branch on the same number regardless of which `wait` form ran.
 */
export const WAIT_ALL_EXIT_CODES: Record<WaitAllOutcome, number> = {
  drained: 0,
  timeout: 124,
};

/** Map a `wait --all` outcome to its exit code. */
export function waitAllExitCode(outcome: WaitAllOutcome): number {
  return WAIT_ALL_EXIT_CODES[outcome];
}
