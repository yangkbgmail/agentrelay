import type { RelayJob } from "./types.js";

/**
 * One `waiting_for_reset` job whose reset time has already passed — it *should*
 * have been resumed by now but hasn't. Computed purely from the job list and an
 * injected `now` (epoch ms) — no clock, no queue, no I/O — so `agentrelay
 * overdue` is unit-testable end to end.
 */
export interface OverdueEntry {
  /** The overdue waiting job this row describes. */
  job: RelayJob;
  /** Milliseconds the job is past its reset time (always ≥ the report's threshold). */
  overdueMs: number;
  /** 1-based rank in the report (1 = most overdue). */
  position: number;
}

/**
 * The set of jobs that are past due for a resume. Where `upcoming` looks
 * forward ("what resumes next, and when?"), `overdue` looks at what has slipped:
 * jobs whose `resetAt` is in the past but which are still sitting in
 * `waiting_for_reset`. A healthy relay resumes these within a poll interval, so
 * a growing overdue list is the clearest symptom that the resume loop
 * (daemon/tick) has stalled or died.
 */
export interface OverdueReport {
  /** Overdue rows, most-overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  total: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The largest `overdueMs` across all matching jobs (0 when none match). */
  maxOverdueMs: number;
  /** The threshold (ms past due) a job had to clear to be counted (0 = any past-due job). */
  thresholdMs: number;
}

/** Options for {@link buildOverdueReport}. */
export interface OverdueOptions {
  /**
   * Only count jobs overdue by at least this many milliseconds. Filters out the
   * momentary "0–N seconds past due, a tick will grab it any moment" noise so
   * the report surfaces genuinely-stuck jobs. Defaults to 0 (every past-due
   * job). Negative or non-finite values are treated as 0.
   */
  thresholdMs?: number;
  /** Trim `entries` to the most-overdue N; `total`/`maxOverdueMs` still reflect the full set. */
  limit?: number;
}

/**
 * Order two overdue jobs by how long they've been past due: most overdue first
 * (largest `overdueMs`, i.e. oldest `resetAt`), then oldest `createdAt`, then id
 * — so the ordering is fully deterministic even when two jobs share a reset
 * time. The `resetAt` comparison is inverted relative to `next`/`upcoming`
 * (which surface the *soonest* due) because the biggest concern here is the job
 * that has waited the longest.
 */
function compareOverdue(a: RelayJob, b: RelayJob): number {
  const ra = Date.parse(a.resetAt as string);
  const rb = Date.parse(b.resetAt as string);
  if (ra !== rb) return ra - rb; // oldest resetAt (most overdue) first
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the overdue report: the `waiting_for_reset` jobs with a parseable
 * `resetAt` that has already passed by at least `thresholdMs`, ranked
 * most-overdue first. This reads exactly the same set the scheduler's due-logic
 * acts on, so `overdue` reports "what the relay should already have resumed but
 * hasn't" without duplicating the queue's due check.
 *
 * `limit` (when a positive integer) trims the returned `entries` to the N most
 * overdue, but `total`/`maxOverdueMs` still reflect the full set so callers can
 * honestly report "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: OverdueOptions = {}
): OverdueReport {
  const thresholdMs =
    typeof options.thresholdMs === "number" && Number.isFinite(options.thresholdMs) && options.thresholdMs > 0
      ? options.thresholdMs
      : 0;

  const overdue = jobs
    .filter((job) => {
      if (job.status !== "waiting_for_reset" || job.resetAt === null) return false;
      const resetMs = Date.parse(job.resetAt);
      if (Number.isNaN(resetMs)) return false;
      return now - resetMs >= thresholdMs;
    })
    .sort(compareOverdue);

  const total = overdue.length;
  const maxOverdueMs = total === 0 ? 0 : now - Date.parse(overdue[0].resetAt as string);

  const capped =
    typeof options.limit === "number" && Number.isInteger(options.limit) && options.limit >= 0
      ? overdue.slice(0, options.limit)
      : overdue;

  const entries: OverdueEntry[] = capped.map((job, index) => ({
    job,
    overdueMs: now - Date.parse(job.resetAt as string),
    position: index + 1,
  }));

  return {
    entries,
    total,
    hidden: total - entries.length,
    maxOverdueMs,
    thresholdMs,
  };
}
