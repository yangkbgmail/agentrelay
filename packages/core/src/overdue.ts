import type { RelayJob } from "./types.js";

/**
 * One job that is overdue for resume: still `waiting_for_reset`, its `resetAt`
 * has already passed, yet the scheduler hasn't picked it back up. Computed
 * purely from the job list and an injected `now` (epoch ms) — no clock, no
 * queue, no I/O — so `agentrelay overdue` is unit-testable end to end.
 */
export interface OverdueEntry {
  /** The overdue job this row describes. */
  job: RelayJob;
  /** How long past its reset time the job is, in milliseconds (always > 0). */
  overdueByMs: number;
  /** 1-based rank in the report, most-overdue first (1 = longest overdue). */
  rank: number;
}

/**
 * The set of waiting jobs whose reset time has come and gone without a resume.
 * In a healthy setup a job passes its `resetAt` and gets resumed within one
 * poll interval, so this list is normally empty or near-empty; a growing
 * overdue list is the signal that the resume loop is behind, stuck, or not
 * running. Where `upcoming` looks forward at what's still waiting, `overdue`
 * looks backward at what *should already have happened*.
 */
export interface OverdueReport {
  /** Overdue rows, most-overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The largest `overdueByMs` across all overdue jobs (0 when none). */
  maxOverdueByMs: number;
}

/**
 * Order two overdue jobs by which is more overdue: the earliest reset time is
 * the most overdue and sorts first, then oldest `createdAt`, then id — so the
 * ordering is fully deterministic even when two jobs share a reset time. This
 * mirrors the `next`/`upcoming` tie-break (which resolve ties the same way),
 * only surfaced most-overdue-first instead of soonest-first.
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
 * `resetAt` that has passed by at least `minOverdueMs`, ranked most-overdue
 * first. A brief overshoot right after a reset is expected (the daemon resumes
 * on its next tick), so `minOverdueMs` lets callers ignore jobs that are only a
 * moment past-due and focus on ones the loop has genuinely failed to pick up.
 *
 * `limit` (when a non-negative integer) trims the returned `entries` to the
 * most-overdue N, but `totalOverdue`/`maxOverdueByMs` still reflect the full
 * set so callers can honestly report "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: { limit?: number; minOverdueMs?: number } = {}
): OverdueReport {
  const threshold = typeof options.minOverdueMs === "number" && options.minOverdueMs > 0 ? options.minOverdueMs : 0;

  const overdue = jobs
    .filter((job) => {
      if (job.status !== "waiting_for_reset" || job.resetAt === null) return false;
      const resetMs = Date.parse(job.resetAt);
      if (Number.isNaN(resetMs)) return false;
      return now - resetMs >= threshold && now - resetMs > 0;
    })
    .sort(compareOverdue);

  const totalOverdue = overdue.length;
  const maxOverdueByMs = overdue.reduce((max, job) => Math.max(max, now - Date.parse(job.resetAt as string)), 0);

  const { limit } = options;
  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? overdue.slice(0, limit) : overdue;

  const entries: OverdueEntry[] = capped.map((job, index) => ({
    job,
    overdueByMs: now - Date.parse(job.resetAt as string),
    rank: index + 1,
  }));

  return {
    entries,
    totalOverdue,
    hidden: totalOverdue - entries.length,
    maxOverdueByMs,
  };
}
