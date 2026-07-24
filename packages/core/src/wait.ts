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

// ---------------------------------------------------------------------------
// Group wait — block until *every* job in a set (e.g. a `--project` scope, or
// all currently-active jobs) reaches a terminal state, then return one
// aggregate outcome. Where `evaluateWait` follows a single job, this lets a
// script drain the whole relay queue and branch on whether all of it succeeded:
//
//   agentrelay wait --all --timeout 6h && deploy   # deploy only if nothing failed
//
// The watch set is the list of full job ids captured when the wait starts; each
// poll re-tallies them against the current store. Ids that vanish mid-wait
// (pruned) count as `missing` rather than blocking forever. Pure: the caller
// owns the store reads and the timeout clock.

/** Per-outcome tally of a group wait's watch set at one poll. */
export interface GroupWaitCounts {
  /** Size of the watch set (ids being followed). */
  total: number;
  /** Still queued/waiting/resuming (not yet terminal, still in the store). */
  pending: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** Watched ids no longer in the store (removed or pruned mid-wait). */
  missing: number;
}

/**
 * Tally each watched id against the current jobs-by-id snapshot. A watched id
 * that's absent counts as `missing`; a present non-terminal job as `pending`;
 * otherwise it lands in its terminal bucket. Pure — no store, no clock.
 */
export function tallyGroupWait(watchIds: string[], jobsById: Map<string, RelayJob>): GroupWaitCounts {
  const counts: GroupWaitCounts = {
    total: watchIds.length,
    pending: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    missing: 0,
  };
  for (const id of watchIds) {
    const job = jobsById.get(id);
    if (!job) {
      counts.missing++;
      continue;
    }
    if (!isTerminalStatus(job.status)) {
      counts.pending++;
      continue;
    }
    if (job.status === "completed") counts.completed++;
    else if (job.status === "failed") counts.failed++;
    else if (job.status === "cancelled") counts.cancelled++;
  }
  return counts;
}

/**
 * A group wait is over once nothing in the watch set is still pending — every
 * id has either settled into a terminal state or vanished from the store. An
 * empty watch set is done immediately (nothing to wait for).
 */
export function evaluateGroupWait(counts: GroupWaitCounts): { done: boolean } {
  return { done: counts.pending === 0 };
}

/**
 * Collapse a group tally (plus whether the deadline was hit with jobs still
 * pending) into one aggregate outcome, so the wait maps to a single exit code
 * via {@link waitExitCode}. Precedence, strongest "something went wrong" first:
 *
 *   failed (1) > timeout (124) > cancelled (2) > missing (5) > completed (0)
 *
 * A definite failure is the most actionable CI signal, so it dominates even a
 * timeout; if nothing failed but the deadline passed with work still pending,
 * `timeout`; a user cancellation or a pruned-away job rank below that; only an
 * all-`completed` set (or an empty watch set) yields `completed`.
 */
export function groupWaitOutcome(counts: GroupWaitCounts, timedOut: boolean): WaitOutcome {
  if (counts.failed > 0) return "failed";
  if (timedOut && counts.pending > 0) return "timeout";
  if (counts.cancelled > 0) return "cancelled";
  if (counts.missing > 0) return "missing";
  return "completed";
}
