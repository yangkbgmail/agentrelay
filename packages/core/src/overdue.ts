import type { RelayJob } from "./types.js";

/**
 * A job that should already have resumed but hasn't: it is still
 * `waiting_for_reset` even though its `resetAt` is in the past. This is the
 * exact silent failure the whole relay exists to prevent — the rate limit
 * cleared, yet nothing picked the job back up (a dead/stuck daemon, a crashed
 * tick, a machine that was asleep at the reset). Computed purely from the job
 * list and an injected `now` (epoch ms) — no clock, no queue, no I/O.
 */
export interface OverdueEntry {
  /** The stuck job this row describes. */
  job: RelayJob;
  /** How long past its reset the job has been waiting (ms), always `> graceMs`. */
  overdueMs: number;
  /** 1-based rank, most-overdue first (1 = worst). */
  position: number;
}

/**
 * The backlog of past-due resumes. Where `upcoming` shows the forward runway
 * (what resumes next and when), `overdue` isolates the jobs that are *already*
 * late — the ones a healthy resume loop would have cleared. An empty report is
 * the good state; a non-empty one usually means the daemon/tick isn't running.
 */
export interface OverdueReport {
  /** Overdue rows, worst (most overdue) first. Trimmed to `limit` when given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The grace threshold used, in ms — a job counts as overdue only past this. */
  graceMs: number;
  /** The single largest `overdueMs` across all overdue jobs, or null when none. */
  worstOverdueMs: number | null;
}

export interface OverdueOptions {
  /**
   * Only flag a job once it has been past due by more than this many ms. Filters
   * out jobs that just barely passed their reset (a tick simply hasn't fired
   * yet). Defaults to 0 — any strictly past-due waiting job counts.
   */
  graceMs?: number;
  /** Trim the returned `entries` to the worst N; totals still count them all. */
  limit?: number;
}

/**
 * Order two overdue jobs worst-first: the earliest `resetAt` has been waiting
 * longest, so it ranks first. Ties break by oldest `createdAt`, then id, so the
 * ordering is fully deterministic. This is the same key `upcoming` sorts on
 * (soonest reset first) — the two commands are just opposite ends of the same
 * resetAt-ordered line, split at `now`.
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
 * Build the overdue backlog: `waiting_for_reset` jobs whose parseable `resetAt`
 * is more than `graceMs` in the past, ranked worst-first. `totalOverdue` and
 * `worstOverdueMs` always reflect the full set even when `limit` trims the rows,
 * so callers can honestly report "N more not shown" and the worst case.
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: OverdueOptions = {}
): OverdueReport {
  const graceMs = typeof options.graceMs === "number" && options.graceMs > 0 ? options.graceMs : 0;

  const overdue = jobs
    .filter((job) => {
      if (job.status !== "waiting_for_reset" || job.resetAt === null) return false;
      const resetMs = Date.parse(job.resetAt);
      if (Number.isNaN(resetMs)) return false;
      return now - resetMs > graceMs;
    })
    .sort(compareOverdue);

  const totalOverdue = overdue.length;
  const worstOverdueMs = totalOverdue > 0 ? now - Date.parse(overdue[0].resetAt as string) : null;

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
    totalOverdue,
    hidden: totalOverdue - entries.length,
    graceMs,
    worstOverdueMs,
  };
}
