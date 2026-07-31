import type { RelayJob } from "./types.js";

/**
 * One job that is *past due*: `waiting_for_reset` with a `resetAt` that has
 * already elapsed, yet still sitting in the queue. A healthy relay drains these
 * on the next tick, so anything that lingers here — especially by more than a
 * few poll intervals — is a signal the resume loop is stuck (daemon dead, no
 * cron firing `tick`, the agent binary missing from PATH, etc.).
 *
 * Computed purely from the job list and an injected `now` (epoch ms) — no
 * clock, no queue, no I/O — so `agentrelay overdue` is unit-testable end to end.
 */
export interface OverdueEntry {
  /** The overdue job this row describes. */
  job: RelayJob;
  /** How long ago its reset time passed, in ms (always > 0 for an overdue job). */
  overdueByMs: number;
  /** 1-based position, most-overdue first (1 = the longest-stuck job). */
  position: number;
}

/**
 * The set of resumes the relay *should* already have made but hasn't: every
 * `waiting_for_reset` job whose reset time is in the past. Where `upcoming`
 * looks forward at what's still pending and `next` names the single soonest
 * move, `overdue` is a health lens — it isolates the jobs a working scheduler
 * would have picked up by now, so an empty report means the loop is keeping up.
 */
export interface OverdueReport {
  /** Overdue rows, longest-stuck first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The largest `overdueByMs` across the full set (0 when nothing is overdue). */
  worstOverdueByMs: number;
}

/** Options for {@link buildOverdueReport}. */
export interface OverdueOptions {
  /** Show at most N rows; totals still count every overdue job. */
  limit?: number;
  /**
   * Only count a job as overdue once it has been past due for at least this
   * many ms. Filters out the transient "due this very tick but not yet drained"
   * jobs so a threshold like 5m surfaces only genuinely-stuck resumes. Defaults
   * to 0 (every job whose reset time has passed).
   */
  minOverdueMs?: number;
}

/**
 * Order two overdue jobs by how long they've been stuck: the earliest reset
 * time (longest overdue) wins, then oldest `createdAt`, then id — so the
 * ordering is fully deterministic even when two jobs share a reset time. This
 * mirrors `selectNextResume`/`buildUpcomingTimeline`'s tie-break, keeping the
 * three timeline views consistent about which job "comes first".
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
 * `resetAt` that has already elapsed (by at least `minOverdueMs`), sorted
 * longest-stuck first. This is exactly the subset of the scheduler's `listDue`
 * set that a *healthy* loop would have drained already, so a non-empty report
 * is the job-side counterpart to `doctor`'s daemon-heartbeat warning.
 *
 * `limit` (a non-negative integer) trims the returned `entries` to the N most
 * overdue, but `totalOverdue`/`worstOverdueByMs` still reflect the full set so
 * callers can honestly report "N more not shown".
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
      return now - resetMs >= minOverdueMs && resetMs <= now;
    })
    .sort(compareOverdue);

  const totalOverdue = overdue.length;
  const worstOverdueByMs = totalOverdue === 0 ? 0 : now - Date.parse(overdue[0].resetAt as string);

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
    worstOverdueByMs,
  };
}
