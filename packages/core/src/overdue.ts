import type { RelayJob } from "./types.js";

// Overdue detection — the per-job counterpart to the daemon heartbeat check.
//
// `doctor`'s heartbeat check answers "is the resume loop alive at all?" and
// `next` answers "which single job resumes soonest?", but neither tells you
// *which* waiting jobs are already past their reset and by *how long*. That's
// the top real-world symptom of a stalled relay: the daemon is (or looks)
// alive, yet jobs sit in `waiting_for_reset` well past the moment the scheduler
// should have picked them up — a crashed poll loop, a clock skew, a spawn that
// never returns. `selectOverdueJobs` surfaces exactly that set, ranked by how
// badly each has slipped, so `agentrelay overdue` can flag stuck work at a
// glance (and exit non-zero for cron/CI alerting).
//
// Pure: computed from the job list and an injected `now` (epoch ms). No clock,
// no queue, no I/O — so the command is unit-testable end to end.

/** A single job that is past its reset time but has not been resumed. */
export interface OverdueJob {
  job: RelayJob;
  /**
   * Milliseconds the job is past its reset time (`now - resetAt`). Always
   * strictly greater than the configured threshold — jobs merely a poll
   * interval late are not reported.
   */
  overdueMs: number;
}

/**
 * The overdue picture for a job list at a given `now`: the overdue jobs
 * themselves plus enough context to say "N of M waiting jobs are stuck".
 */
export interface OverdueReport {
  /** Overdue jobs, most-overdue first. */
  jobs: OverdueJob[];
  /**
   * Total jobs in `waiting_for_reset` with a parseable `resetAt` — the set
   * `overdue` is drawn from, whether or not each is actually late. Lets the
   * caller phrase "3 of 12 waiting jobs overdue".
   */
  totalWaiting: number;
  /** The largest `overdueMs` in `jobs`, or 0 when nothing is overdue. */
  maxOverdueMs: number;
}

/**
 * A job is only flagged once it's been past its reset by more than this many
 * milliseconds, so normal scheduler poll latency (a job due a few seconds ago
 * that the next tick will pick up) isn't reported as stuck. 60s is comfortably
 * above the default fast-poll interval while still catching genuine stalls
 * quickly.
 */
export const DEFAULT_OVERDUE_THRESHOLD_MS = 60_000;

export interface OverdueOptions {
  /**
   * Only report a job once `now - resetAt` exceeds this many milliseconds.
   * Defaults to {@link DEFAULT_OVERDUE_THRESHOLD_MS}. Negative values are
   * clamped to 0 (report every past-due job).
   */
  thresholdMs?: number;
}

/**
 * Order two overdue jobs so the most-overdue comes first, then oldest
 * `createdAt`, then id — fully deterministic even when two jobs share an
 * overdue amount (mirrors `next`'s tiebreak so the two commands agree on
 * ordering).
 */
function compareOverdue(a: OverdueJob, b: OverdueJob): number {
  if (a.overdueMs !== b.overdueMs) return b.overdueMs - a.overdueMs;
  if (a.job.createdAt !== b.job.createdAt) return a.job.createdAt < b.job.createdAt ? -1 : 1;
  if (a.job.id === b.job.id) return 0;
  return a.job.id < b.job.id ? -1 : 1;
}

/**
 * Find every `waiting_for_reset` job whose parseable `resetAt` is more than
 * `thresholdMs` in the past — the jobs the scheduler should already have
 * resumed. Returns them ranked by {@link compareOverdue} plus the total
 * waiting-for-reset count for context. Jobs with a null/unparseable `resetAt`
 * are counted in neither total (they can't be placed on a timeline), matching
 * how `next` treats them.
 */
export function selectOverdueJobs(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: OverdueOptions = {}
): OverdueReport {
  const threshold = Math.max(0, options.thresholdMs ?? DEFAULT_OVERDUE_THRESHOLD_MS);

  let totalWaiting = 0;
  const overdue: OverdueJob[] = [];

  for (const job of jobs) {
    if (job.status !== "waiting_for_reset" || job.resetAt === null) continue;
    const resetMs = Date.parse(job.resetAt);
    if (Number.isNaN(resetMs)) continue;

    totalWaiting += 1;
    const overdueMs = now - resetMs;
    if (overdueMs > threshold) overdue.push({ job, overdueMs });
  }

  overdue.sort(compareOverdue);
  const maxOverdueMs = overdue.length > 0 ? overdue[0].overdueMs : 0;

  return { jobs: overdue, totalWaiting, maxOverdueMs };
}
