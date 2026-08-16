// Pure decision logic for `agentrelay drain` — block a script until the whole
// queue is caught up (every active job has reached a terminal state), then exit
// with a code a caller can branch on. Where `eta` answers "when *will* the queue
// be caught up?" as a one-shot snapshot, and `wait <id>` follows a single job to
// its conclusion, `drain` is the blocking, fleet-wide sibling: it waits for the
// relay to have nothing left in flight, so a script can gate on it:
//
//   agentrelay daemon &                       # keep resuming rate-limited jobs
//   agentrelay drain --timeout 8h && deploy    # deploy once the queue is empty
//
// "Active" here means the same non-terminal set the scheduler still has work for
// (queued / waiting_for_reset / resuming) — identical to `countActiveJobs` and
// the stats `ACTIVE_STATUSES`, so all three surfaces agree on "what is in
// flight". The polling loop (re-reading the store as a separate daemon/tick
// process advances jobs) lives in the CLI; everything here is a pure function of
// a job snapshot, so the drained/timeout mapping is unit-testable without a
// clock, a store, or a spawned process.

import { ACTIVE_STATUSES } from "./stats.js";
import type { RelayJob } from "./types.js";

/**
 * How a `drain` ended. `drained` = the queue has no active jobs left; `timeout`
 * = still had jobs in flight when the deadline passed.
 */
export type DrainOutcome = "drained" | "timeout";

/**
 * Exit code per outcome, so `agentrelay drain` composes in shell `&&`/`||`
 * chains and CI steps without parsing output. `timeout` uses 124 to match GNU
 * coreutils `timeout(1)` and `agentrelay wait`, a convention scripters already
 * branch on.
 */
export const DRAIN_EXIT_CODES: Record<DrainOutcome, number> = {
  drained: 0,
  timeout: 124,
};

/** Map an outcome to its exit code. */
export function drainExitCode(outcome: DrainOutcome): number {
  return DRAIN_EXIT_CODES[outcome];
}

/**
 * A snapshot of how much is still in flight. The per-status breakdown lets the
 * CLI print an informative progress line ("3 active: 2 waiting, 1 resuming")
 * without re-deriving the counts.
 */
export interface DrainProgress {
  /** True when nothing is active — the queue is drained. */
  done: boolean;
  /** Total active jobs remaining (queued + waiting_for_reset + resuming). */
  active: number;
  /** Active jobs in the `queued` state. */
  queued: number;
  /** Active jobs in the `waiting_for_reset` state. */
  waiting: number;
  /** Active jobs in the `resuming` state. */
  resuming: number;
  /** Set to `drained` once `active` reaches 0; otherwise absent (still draining). */
  outcome?: DrainOutcome;
}

const ACTIVE = new Set<RelayJob["status"]>(ACTIVE_STATUSES);

/**
 * Decide, from the current store snapshot, whether the queue is drained. Returns
 * `done: false` with the per-status active breakdown while anything is still in
 * flight; `done: true` with `outcome: "drained"` once no active job remains.
 * Pure: the caller supplies the snapshot and owns the timeout clock.
 */
export function evaluateDrain(jobs: RelayJob[]): DrainProgress {
  let queued = 0;
  let waiting = 0;
  let resuming = 0;
  for (const job of jobs) {
    if (!ACTIVE.has(job.status)) continue;
    if (job.status === "queued") queued += 1;
    else if (job.status === "waiting_for_reset") waiting += 1;
    else if (job.status === "resuming") resuming += 1;
  }
  const active = queued + waiting + resuming;
  return active === 0
    ? { done: true, active: 0, queued: 0, waiting: 0, resuming: 0, outcome: "drained" }
    : { done: false, active, queued, waiting, resuming };
}
