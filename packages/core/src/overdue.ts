import type { RelayJob } from "./types.js";

/**
 * One overdue job, plus the context the CLI needs to render a "how late" row.
 * A job is overdue when it is still `waiting_for_reset` even though its
 * `resetAt` is strictly in the past — the relay should already have resumed it
 * on an earlier tick, but hasn't. Computed purely from the job list and an
 * injected `now` (epoch ms), so `agentrelay overdue` is unit-testable end to
 * end with no clock, queue, or I/O.
 */
export interface OverdueEntry {
  /** The overdue job this row describes. */
  job: RelayJob;
  /** How long ago its reset time passed, in milliseconds (always > 0). */
  overdueByMs: number;
  /** 1-based position in the report (1 = most overdue). */
  position: number;
}

/**
 * The diagnostic view of resumes the relay has fallen behind on: every
 * `waiting_for_reset` job whose `resetAt` is already past, ordered worst-first.
 * Where `upcoming` shows the forward runway (what resumes next and when),
 * `overdue` answers the alarm question — "what should already be running but
 * isn't?" A non-empty report on a live daemon means the resume loop is stuck
 * (dead daemon, missing adapter binary, unwritable store) and jobs are silently
 * stranded past their reset.
 */
export interface OverdueReport {
  /** Overdue rows, most-overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The largest `overdueByMs` across all overdue jobs (0 when none). */
  worstOverdueByMs: number;
}

/**
 * Order two overdue jobs worst-first: the one whose reset passed earliest (so
 * it has been waiting longest) comes first, then oldest `createdAt`, then id —
 * fully deterministic even when two jobs share a reset time. This puts the
 * job the relay has neglected the longest at the top of the report.
 */
function compareOverdue(a: RelayJob, b: RelayJob): number {
  const ra = Date.parse(a.resetAt as string);
  const rb = Date.parse(b.resetAt as string);
  if (ra !== rb) return ra - rb;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the overdue report: the `waiting_for_reset` jobs with a parseable
 * `resetAt` strictly earlier than `now`, sorted worst-first. This is the subset
 * of `upcoming`'s waiting jobs that are already due but still unresumed — the
 * ones a healthy scheduler tick would have cleared. A job resetting exactly at
 * `now` is "due", not overdue, and is excluded (its `overdueByMs` would be 0).
 *
 * `limit` (when a non-negative integer) trims the returned `entries` to the
 * worst N, but `totalOverdue`/`worstOverdueByMs` still reflect the full set so
 * callers can honestly report "N more not shown".
 */
export function buildOverdueReport(jobs: RelayJob[], now: number = Date.now(), limit?: number): OverdueReport {
  const overdue = jobs
    .filter(
      (job) =>
        job.status === "waiting_for_reset" &&
        job.resetAt !== null &&
        !Number.isNaN(Date.parse(job.resetAt)) &&
        Date.parse(job.resetAt) < now
    )
    .sort(compareOverdue);

  const totalOverdue = overdue.length;
  const worstOverdueByMs = totalOverdue === 0 ? 0 : now - Date.parse(overdue[0].resetAt as string);

  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? overdue.slice(0, limit) : overdue;

  const entries: OverdueEntry[] = capped.map((job, index) => ({
    job,
    overdueByMs: now - Date.parse(job.resetAt as string),
    position: index + 1,
  }));

  return {
    entries,
    totalOverdue,
    hidden: totalOverdue - entries.length,
    worstOverdueByMs,
  };
}
