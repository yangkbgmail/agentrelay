import type { RelayJob } from "./types.js";

/**
 * Recovery of jobs orphaned mid-resume.
 *
 * The scheduler resumes a job by first calling `markResuming` (status →
 * `resuming`, attempts bumped) and only later marking a terminal outcome
 * (`completed`/`failed`) or re-parking it (`waiting_for_reset`). If the process
 * dies in between — a daemon OOM-killed, a `SIGKILL`, a host reboot mid-run —
 * the job is left **stuck in `resuming` forever**:
 *
 * - `listDue` only returns `waiting_for_reset` jobs, so no future tick picks it
 *   up again;
 * - `agentrelay retry` refuses it (`canRequeue` rejects `resuming` to avoid
 *   racing a genuinely in-flight run).
 *
 * So the one job that most needed the relay silently never resumes. This module
 * is the *pure* half of the fix: given the job list and an injected `now`, it
 * decides which `resuming` jobs look orphaned (have sat in that state longer
 * than any live resume plausibly would). The queue mutation and the clock live
 * in the CLI, mirroring how `doctor`/`prune` split pure logic from I/O.
 */

/**
 * How long a job may sit in `resuming` before it's treated as orphaned. A live
 * resume writes a fresh `updatedAt` the instant it enters `resuming`, so a job
 * still marked `resuming` this long afterward almost certainly belongs to a
 * loop that died. 30 minutes is generous enough to clear even a slow agent run
 * while still catching a crash within a poll or two of the next daemon start.
 */
export const DEFAULT_STUCK_RESUMING_MS = 30 * 60_000;

export interface StuckResumingOptions {
  /** Reference "now" (epoch ms) the ages are measured against. */
  nowMs: number;
  /**
   * Minimum time (ms) a job must have been `resuming` to count as stuck.
   * Defaults to {@link DEFAULT_STUCK_RESUMING_MS}. `0` selects every `resuming`
   * job regardless of age — the right choice when the operator *knows* the loop
   * is dead and wants to reclaim everything immediately.
   */
  stuckAfterMs?: number;
}

export interface StuckResumingReport {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Jobs currently in the `resuming` state, before the age threshold. */
  resuming: number;
  /** The staleness threshold applied (ms). */
  stuckAfterMs: number;
  /**
   * The `resuming` jobs judged orphaned — old enough (or with an unusable
   * `updatedAt`) to reclaim — ordered oldest-stuck first, so a caller reclaiming
   * or listing them addresses the longest-waiting job before the rest.
   */
  stuck: RelayJob[];
}

/** Epoch ms of an ISO timestamp, or NaN when missing/unparseable. */
function updatedMs(iso: string): number {
  return Date.parse(iso);
}

/**
 * Identify jobs stuck in `resuming` past the staleness threshold. Pure and
 * non-mutating.
 *
 * A `resuming` job whose `updatedAt` can't be parsed is treated as stuck: a loop
 * actively running the job always writes a valid, fresh timestamp, so an
 * unparseable one can only come from a store no live loop is maintaining — safe
 * to reclaim rather than strand forever.
 */
export function selectStuckResumingJobs(jobs: RelayJob[], options: StuckResumingOptions): StuckResumingReport {
  const stuckAfterMs =
    options.stuckAfterMs !== undefined ? Math.max(0, options.stuckAfterMs) : DEFAULT_STUCK_RESUMING_MS;
  const { nowMs } = options;

  let resuming = 0;
  const stuck: Array<{ job: RelayJob; ageKey: number }> = [];
  for (const job of jobs) {
    if (job.status !== "resuming") continue;
    resuming += 1;
    const ms = updatedMs(job.updatedAt);
    // Unparseable timestamp → treat as infinitely old (definitely not a live run).
    const age = Number.isNaN(ms) ? Number.POSITIVE_INFINITY : nowMs - ms;
    if (age >= stuckAfterMs) {
      stuck.push({ job, ageKey: Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms });
    }
  }

  // Oldest-stuck first: smaller `updatedAt` ms = longer waiting. Unparseable
  // timestamps (ageKey -Infinity) sort first as the most suspect.
  stuck.sort((a, b) => a.ageKey - b.ageKey);

  return {
    total: jobs.length,
    resuming,
    stuckAfterMs,
    stuck: stuck.map((entry) => entry.job),
  };
}
