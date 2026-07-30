import type { RelayJob } from "./types.js";

/**
 * One `waiting_for_reset` job whose reset time has already passed but which is
 * still sitting in the queue — the scheduler should have resumed it by now.
 * Computed purely from the job list and an injected `now` (epoch ms) — no
 * clock, no queue, no I/O — so `agentrelay overdue` is unit-testable end to end.
 */
export interface OverdueEntry {
  /** The past-due waiting job this row describes. */
  job: RelayJob;
  /** How long ago its reset time passed, in ms (always >= 0). */
  overdueByMs: number;
  /** 1-based position, most-overdue first (1 = the longest-stuck job). */
  position: number;
}

/**
 * The set of jobs the relay was supposed to resume but hasn't: every
 * `waiting_for_reset` job whose `resetAt` is in the past. Where `upcoming`
 * shows the forward-looking runway (what resumes next and when), `overdue` is a
 * diagnostic — in a healthy relay it is empty or transient (a scheduler tick
 * clears each within one poll interval); jobs that linger here, especially with
 * a large `overdueByMs`, mean the resume loop is stalled or dead.
 */
export interface OverdueReport {
  /** Rows, most-overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The worst offender's lateness in ms (0 when nothing is overdue). */
  maxOverdueByMs: number;
}

/**
 * Options for {@link buildOverdueReport}.
 */
export interface OverdueOptions {
  /** Show at most N rows; totals still count every overdue job. */
  limit?: number;
  /**
   * Only count a job as overdue once it has been past-due for at least this
   * many ms. Lets a monitor ignore the transient lag between a job coming due
   * and the next scheduler tick picking it up (e.g. set to the poll interval).
   * Defaults to 0 (every past-due job counts).
   */
  minOverdueMs?: number;
}

/**
 * Order two overdue jobs by how long each has been stuck: the earliest
 * `resetAt` (most overdue) wins, then oldest `createdAt`, then id — so the
 * ordering is fully deterministic even when two jobs share a reset time. This
 * mirrors `buildUpcomingTimeline`'s tie-break, so a job's relative order is
 * consistent across the two views.
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
 * `resetAt` that has already passed (by at least `minOverdueMs`), sorted
 * most-overdue first. This is the subset of `upcoming`'s timeline that a
 * scheduler tick would resume immediately — so a non-empty, growing, or
 * long-latency result is the clearest per-job signal that the resume loop
 * isn't running.
 *
 * `limit` (when a positive integer) trims the returned `entries` to the
 * most-overdue N, but `totalOverdue`/`maxOverdueByMs` still reflect the full
 * set so callers can honestly report "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: OverdueOptions = {}
): OverdueReport {
  const minOverdueMs = typeof options.minOverdueMs === "number" && options.minOverdueMs > 0 ? options.minOverdueMs : 0;

  const overdue = jobs
    .filter((job) => {
      if (job.status !== "waiting_for_reset" || job.resetAt === null) return false;
      const resetMs = Date.parse(job.resetAt);
      if (Number.isNaN(resetMs)) return false;
      return now - resetMs >= minOverdueMs;
    })
    .sort(compareOverdue);

  const totalOverdue = overdue.length;
  const maxOverdueByMs = totalOverdue > 0 ? now - Date.parse(overdue[0].resetAt as string) : 0;

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
