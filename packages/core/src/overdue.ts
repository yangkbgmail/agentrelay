import type { RelayJob } from "./types.js";

/**
 * One overdue job — a `waiting_for_reset` job whose reset time has already
 * passed (by more than any grace window) yet it is still sitting in the queue
 * instead of resuming. Computed purely from the job list and an injected `now`
 * (epoch ms) — no clock, no queue, no I/O — so `agentrelay overdue` is
 * unit-testable end to end.
 */
export interface OverdueEntry {
  /** The stuck waiting job this row describes. */
  job: RelayJob;
  /** How long ago the reset time passed, in ms (always positive — past the grace window). */
  overdueMs: number;
  /** 1-based rank, most overdue first (1 = the longest-stuck job). */
  position: number;
}

/**
 * The set of jobs the relay *should have already resumed* but hasn't. Where
 * `upcoming` is forward-looking ("what resumes next?"), `overdue` is the alarm:
 * every waiting job whose reset time is in the past by more than the grace
 * window, longest-stuck first. A non-empty report with a healthy daemon means
 * the resume loop is dead or wedged — the exact silent failure the relay exists
 * to prevent.
 */
export interface OverdueReport {
  /** Ordered rows, most-overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The largest `overdueMs` across the full overdue set (0 when none are overdue). */
  maxOverdueMs: number;
  /** The grace window (ms) applied — jobs overdue by less than this are not counted. */
  graceMs: number;
}

/**
 * Order two overdue jobs by how long they've been stuck: the earliest reset
 * time (longest overdue) wins, then oldest `createdAt`, then id — fully
 * deterministic even when two jobs share a reset time. This is the mirror of
 * `upcoming`'s tie-break: both key on resetAt→createdAt→id, but `overdue`
 * surfaces the oldest-due first (the most alarming) rather than the soonest.
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
 * `resetAt` that passed more than `graceMs` ago, sorted longest-stuck first.
 *
 * The grace window (default 0 — every strictly-past job counts) exists to
 * distinguish "just came due, the daemon will pick it up on its next tick" from
 * "should have resumed long ago, something is wrong". A monitor might run with
 * `graceMs` set to a few multiples of the poll interval so a healthy relay
 * never trips the alarm.
 *
 * `limit` (when a non-negative integer) trims the returned `entries` to the
 * most-overdue N, but `totalOverdue`/`maxOverdueMs` still reflect the full set
 * so callers can honestly report "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: { limit?: number; graceMs?: number } = {}
): OverdueReport {
  const graceMs =
    typeof options.graceMs === "number" && Number.isFinite(options.graceMs) ? Math.max(0, options.graceMs) : 0;

  const overdue = jobs
    .filter((job) => {
      if (job.status !== "waiting_for_reset" || job.resetAt === null) return false;
      const resetMs = Date.parse(job.resetAt);
      if (Number.isNaN(resetMs)) return false;
      return now - resetMs > graceMs;
    })
    .sort(compareOverdue);

  const totalOverdue = overdue.length;
  const maxOverdueMs = totalOverdue > 0 ? now - Date.parse(overdue[0].resetAt as string) : 0;

  const limit = options.limit;
  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? overdue.slice(0, limit) : overdue;

  const entries: OverdueEntry[] = capped.map((job, index) => ({
    job,
    overdueMs: now - Date.parse(job.resetAt as string),
    position: index + 1,
  }));

  return {
    entries,
    totalOverdue,
    hidden: totalOverdue - entries.length,
    maxOverdueMs,
    graceMs,
  };
}
