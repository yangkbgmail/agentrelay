// Pure decision logic for `agentrelay drain` — block a script until the whole
// queue has settled (no job left in an active status), then exit with a code
// that reflects whether everything drained cleanly. Where `wait <id>` follows a
// single job to its conclusion, `drain` follows the *entire* relay to quiet, so
// a caller can gate on "the relay has finished everything it was going to
// resume":
//
//   agentrelay daemon &                 # keep resuming rate-limited jobs
//   agentrelay drain --timeout 12h && ./publish.sh   # runs only if all drained
//
// The polling loop (re-reading the store as a separate daemon/tick process
// advances jobs) lives in the CLI; everything here is a pure function of a job
// snapshot so the outcome mapping is unit-testable without a clock, a store, or
// a spawned process.

import { ACTIVE_STATUSES } from "./stats.js";
import type { JobStatus, RelayJob } from "./types.js";

/** Whether `status` is one the scheduler still has work to do on. */
export function isActiveStatus(status: JobStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/**
 * A snapshot judgement of how close the queue is to drained. `done` flips to
 * true the moment no active jobs remain — that's the drain loop's stop signal.
 * The counts let the CLI render live progress and let `drainOutcome` decide the
 * exit code without re-scanning.
 */
export interface DrainState {
  /** Jobs still in an active status (queued/waiting_for_reset/resuming). */
  active: number;
  /** Jobs in a terminal status (completed/failed/cancelled). */
  terminal: number;
  /** Jobs in the `failed` terminal state specifically. */
  failed: number;
  /** Total jobs currently in the store. */
  total: number;
  /** True once `active === 0` — the queue has settled, drain can stop. */
  done: boolean;
}

/**
 * How a `drain` ended:
 * - `empty`     — the store had no jobs at all; nothing to drain.
 * - `drained`   — the queue settled and no job is in `failed`.
 * - `drained_with_failures` — the queue settled but ≥1 job is `failed`.
 * - `timeout`   — the deadline passed while jobs were still active.
 */
export type DrainOutcome = "empty" | "drained" | "drained_with_failures" | "timeout";

/**
 * Exit code per outcome, so `agentrelay drain` composes in shell `&&`/`||`
 * chains and CI steps without parsing output. `timeout` uses 124 to match GNU
 * coreutils `timeout(1)`, mirroring `agentrelay wait`.
 */
export const DRAIN_EXIT_CODES: Record<DrainOutcome, number> = {
  empty: 0,
  drained: 0,
  drained_with_failures: 1,
  timeout: 124,
};

/** Map an outcome to its exit code. */
export function drainExitCode(outcome: DrainOutcome): number {
  return DRAIN_EXIT_CODES[outcome];
}

/**
 * Count the current queue and decide whether the drain loop can stop. Pure: the
 * caller supplies the snapshot and owns the polling clock. `done` is true when
 * no active jobs remain (including an empty store).
 */
export function evaluateDrain(jobs: RelayJob[]): DrainState {
  let active = 0;
  let terminal = 0;
  let failed = 0;
  for (const job of jobs) {
    if (isActiveStatus(job.status)) {
      active += 1;
    } else {
      terminal += 1;
      if (job.status === "failed") failed += 1;
    }
  }
  return { active, terminal, failed, total: jobs.length, done: active === 0 };
}

/**
 * Map a settled (or timed-out) snapshot to a final outcome. `timedOut` is the
 * loop's decision that the deadline passed; it only wins while jobs are still
 * active (a queue that drained *exactly* at the deadline still counts as
 * drained). An empty store is `empty` (exit 0), a settled queue with any
 * `failed` job is `drained_with_failures` (exit 1), otherwise `drained`.
 */
export function drainOutcome(state: DrainState, opts: { timedOut?: boolean } = {}): DrainOutcome {
  if (opts.timedOut && !state.done) return "timeout";
  if (state.total === 0) return "empty";
  if (state.failed > 0) return "drained_with_failures";
  return "drained";
}
