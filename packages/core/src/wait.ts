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
 * Verdict for `agentrelay wait --all` — block a script until the whole relay
 * queue drains (every job reaches a terminal state), then exit with a code that
 * reflects the worst outcome. Where `evaluateWait` follows one job, this follows
 * the entire queue, so a caller can fan out several `run`s and then gate on the
 * relay finishing all of them:
 *
 *   agentrelay run -- claude -p "refactor A"   # may get rate-limited & queued
 *   agentrelay run -- claude -p "refactor B"   # ...and this one too
 *   agentrelay wait --all --timeout 6h && deploy
 *
 * `remaining` is how many jobs are still active (queued/waiting/resuming) and is
 * meaningful only while `done` is false — it lets a `--json`/progress caller show
 * "N still running". `total` counts the terminal jobs the outcome was aggregated
 * over (0 for an empty queue, which is vacuously drained → `completed`).
 */
export interface WaitAllVerdict {
  done: boolean;
  /** Terminal aggregate outcome; present only when `done` is true. */
  outcome?: WaitOutcome;
  /** Jobs still active. Meaningful only while `done` is false. */
  remaining: number;
  /** Terminal jobs the outcome aggregated over. Meaningful only when `done`. */
  total: number;
}

/**
 * Decide, from a snapshot of the whole store, whether every job has settled.
 * The queue is drained once no job is still active (queued/waiting_for_reset/
 * resuming). The aggregate outcome is the *worst* terminal state present, so a
 * script gating on it fails loudly if any single job failed:
 *
 *   any `failed`      -> "failed"      (exit 1)
 *   else any `cancelled` -> "cancelled" (exit 2)
 *   else                 -> "completed" (exit 0)
 *
 * An empty queue (nothing to wait for) is vacuously drained and reports
 * `completed`. Pure: the caller supplies the snapshot and owns the timeout clock.
 */
export function evaluateWaitAll(jobs: RelayJob[]): WaitAllVerdict {
  const active = jobs.filter((j) => !isTerminalStatus(j.status));
  if (active.length > 0) {
    return { done: false, remaining: active.length, total: jobs.length - active.length };
  }
  let outcome: WaitOutcome = "completed";
  for (const job of jobs) {
    if (job.status === "failed") {
      outcome = "failed";
      break; // "failed" is the worst outcome; no need to keep scanning
    }
    if (job.status === "cancelled") outcome = "cancelled";
  }
  return { done: true, outcome, remaining: 0, total: jobs.length };
}
