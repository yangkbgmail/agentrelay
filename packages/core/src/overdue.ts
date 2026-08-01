import type { RelayJob } from "./types.js";

/**
 * One job that should already have resumed but hasn't: it is still
 * `waiting_for_reset` even though its `resetAt` is in the past. Computed purely
 * from the job list and an injected `now` (epoch ms) — no clock, no queue, no
 * I/O — so `agentrelay overdue` is unit-testable end to end.
 */
export interface OverdueEntry {
  /** The stuck waiting job this row describes. */
  job: RelayJob;
  /** Milliseconds `now` is past its reset time. Always > the applied threshold. */
  overdueMs: number;
  /** 1-based rank in the report order (1 = most overdue). */
  position: number;
}

/**
 * The backlog of jobs the relay was supposed to have resumed by now. Where
 * `upcoming` shows the forward runway (what resumes next and when), `overdue`
 * isolates the *past*: jobs whose reset time has come and gone while they're
 * still parked in `waiting_for_reset`. A healthy daemon drains these within a
 * poll interval, so a non-empty (and growing) list is the clearest queue-level
 * signal that the resume loop is dead or stuck — the exact silent failure this
 * tool exists to catch.
 */
export interface OverdueReport {
  /** Rows, most-overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The largest `overdueMs` across all overdue jobs (0 when none). */
  maxOverdueMs: number;
  /** The grace window (ms) applied — a job counts as overdue only past this. */
  thresholdMs: number;
}

/** Options for {@link buildOverdueReport}. */
export interface OverdueOptions {
  /** Keep only the most-overdue N rows in `entries` (totals stay honest). */
  limit?: number;
  /**
   * Grace window in ms: a job is overdue only when `now - resetAt` exceeds this.
   * Defaults to 0 (any job past its reset). A small window (e.g. one poll
   * interval) avoids flagging jobs that merely crossed their reset moments ago.
   */
  thresholdMs?: number;
}

/**
 * Order two overdue jobs by how long they've been stuck: earliest reset time
 * (most overdue) wins, then oldest `createdAt`, then id — fully deterministic
 * even when two jobs share a reset time. This is the reverse-time twin of
 * `upcoming`'s ordering: `upcoming` counts down to the soonest future reset,
 * `overdue` counts up from the longest-past one.
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
 * Build the overdue report: every `waiting_for_reset` job with a parseable
 * `resetAt` that is more than `thresholdMs` in the past, most overdue first.
 * Mirrors the set the scheduler's due-check should have already acted on, so a
 * non-empty result means those resumes are not happening.
 *
 * `limit` (a positive integer) trims the returned `entries` to the most-overdue
 * N, but `totalOverdue`/`maxOverdueMs` still reflect the full set so callers can
 * honestly report "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: OverdueOptions = {}
): OverdueReport {
  const thresholdMs = typeof options.thresholdMs === "number" && options.thresholdMs > 0 ? options.thresholdMs : 0;

  const overdue = jobs
    .filter((job) => {
      if (job.status !== "waiting_for_reset" || job.resetAt === null) return false;
      const resetMs = Date.parse(job.resetAt);
      if (Number.isNaN(resetMs)) return false;
      return now - resetMs > thresholdMs;
    })
    .sort(compareOverdue);

  const totalOverdue = overdue.length;
  const maxOverdueMs = totalOverdue === 0 ? 0 : now - Date.parse(overdue[0].resetAt as string);

  const { limit } = options;
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
    thresholdMs,
  };
}
