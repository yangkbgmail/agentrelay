import type { RelayJob } from "./types.js";

/**
 * One past-due waiting job, plus the context the CLI needs to render an
 * "overdue by" row. Computed purely from the job list and an injected `now`
 * (epoch ms) — no clock, no queue, no I/O — so `agentrelay overdue` is
 * unit-testable end to end.
 */
export interface OverdueEntry {
  /** The waiting job whose reset time has already passed. */
  job: RelayJob;
  /** Milliseconds `now` is past the job's reset time (always positive here). */
  overdueByMs: number;
  /** 1-based rank; 1 = the most overdue job (longest past its reset). */
  position: number;
}

/**
 * The set of jobs the scheduler *should* have resumed already but hasn't: every
 * `waiting_for_reset` job whose `resetAt` has passed (by more than an optional
 * grace period). Where `upcoming` shows the forward runway, `overdue` is its
 * mirror — a job-level "why hasn't this resumed yet?" probe. A non-empty report
 * with a stale/absent daemon is the exact silent failure the relay exists to
 * prevent, so this surfaces it without needing to read `doctor`/`health`.
 */
export interface OverdueReport {
  /** Rows, most-overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The largest `overdueByMs` across all overdue jobs (0 when none). */
  maxOverdueByMs: number;
}

/**
 * Order two waiting jobs by which the scheduler will resume first: earliest
 * reset time wins, then oldest `createdAt`, then id. Ascending reset time also
 * means most-overdue-first (largest `now - resetAt`), so the first row is the
 * job that has been stuck the longest. Matches `next`/`upcoming`'s tie-break
 * exactly for a consistent ordering across the three timeline views.
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
 * `resetAt` that is at least `graceMs` in the past, ordered most-overdue first.
 *
 * `graceMs` (default 0) ignores jobs that only *just* came due — a daemon polls
 * every few seconds, so a job one second past its reset isn't a problem yet.
 * Pass e.g. one poll interval to show only jobs that are genuinely stuck.
 *
 * `limit` (when a non-negative integer) trims the returned `entries` to the
 * most-overdue N, but `totalOverdue`/`maxOverdueByMs` still reflect the full set
 * so callers can honestly report "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: { graceMs?: number; limit?: number } = {}
): OverdueReport {
  const graceMs = typeof options.graceMs === "number" && options.graceMs > 0 ? options.graceMs : 0;
  const cutoff = now - graceMs;

  const overdue = jobs
    .filter(
      (job) =>
        job.status === "waiting_for_reset" &&
        job.resetAt !== null &&
        !Number.isNaN(Date.parse(job.resetAt)) &&
        Date.parse(job.resetAt) <= cutoff
    )
    .sort(compareOverdue);

  const totalOverdue = overdue.length;
  const maxOverdueByMs = totalOverdue === 0 ? 0 : now - Date.parse(overdue[0].resetAt as string);

  const { limit } = options;
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
    maxOverdueByMs,
  };
}
