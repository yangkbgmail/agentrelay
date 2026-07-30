import type { RelayJob } from "./types.js";

/**
 * One `waiting_for_reset` job whose reset time has already passed — the relay
 * *should* have resumed it by now but hasn't. Computed purely from the job list
 * and an injected `now` (epoch ms) — no clock, no queue, no I/O — so `agentrelay
 * overdue` is unit-testable end to end.
 */
export interface OverdueEntry {
  /** The overdue job this row describes. */
  job: RelayJob;
  /** Milliseconds by which its reset time has passed; always ≥ 0. */
  overdueByMs: number;
  /** 1-based position, most-overdue first (1 = the longest-stuck job). */
  position: number;
}

/**
 * The diagnostic view for stuck relays: every `waiting_for_reset` job whose
 * `resetAt` is in the past, ordered worst-first. Where `upcoming` looks forward
 * ("what resumes next, and when?"), `overdue` looks at what should already have
 * resumed — a queue with a long overdue tail usually means the daemon stopped,
 * crashed, or was never started.
 */
export interface OverdueReport {
  /** Overdue rows, longest-stuck first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (past the grace window, before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The largest `overdueByMs` across all overdue jobs; 0 when none are overdue. */
  maxOverdueByMs: number;
  /** The grace window (ms) applied: a job counts as overdue only once past due by more than this. */
  graceMs: number;
}

/**
 * Order two overdue jobs worst-first: the one whose reset passed longest ago
 * comes first, then oldest `createdAt`, then id — so the ordering is fully
 * deterministic even when two jobs share a reset time. This is the reverse of
 * `upcoming`'s soonest-first ordering, since here the *most* overdue job is the
 * most urgent to look at.
 */
function compareOverdue(a: RelayJob, b: RelayJob): number {
  const ra = Date.parse(a.resetAt as string);
  const rb = Date.parse(b.resetAt as string);
  if (ra !== rb) return ra - rb; // earlier reset = more overdue = first
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the overdue report: the `waiting_for_reset` jobs with a parseable
 * `resetAt` that is already past `now` by more than `graceMs`, sorted
 * most-overdue first.
 *
 * `graceMs` (default 0) forgives jobs that only just came due — a daemon polls
 * on an interval, so a job three seconds past its reset isn't stuck. Pass e.g.
 * one poll interval to surface only genuinely-late jobs. `limit` (a positive
 * integer) trims the returned `entries` to the worst N, but `totalOverdue` and
 * `maxOverdueByMs` still reflect the full set so callers can honestly report
 * "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: { graceMs?: number; limit?: number } = {}
): OverdueReport {
  const graceMs = typeof options.graceMs === "number" && options.graceMs > 0 ? options.graceMs : 0;
  const threshold = now - graceMs;

  const overdue = jobs
    .filter(
      (job) =>
        job.status === "waiting_for_reset" &&
        job.resetAt !== null &&
        !Number.isNaN(Date.parse(job.resetAt)) &&
        Date.parse(job.resetAt) <= threshold
    )
    .sort(compareOverdue);

  const totalOverdue = overdue.length;
  const maxOverdueByMs = overdue.reduce((max, job) => Math.max(max, now - Date.parse(job.resetAt as string)), 0);

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
    graceMs,
  };
}
