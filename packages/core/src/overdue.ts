import type { RelayJob } from "./types.js";

/**
 * Default grace period before a passed-due job is called "overdue": 60s, which
 * is two cycles of the daemon's default 30s poll. A healthy, running relay
 * resumes a job within a tick or two of its reset, so anything still waiting a
 * full minute past due almost always means the resume loop (daemon/tick) is
 * absent or stuck — not that the scheduler just hasn't gotten to it yet. The
 * grace keeps `overdue` from crying wolf about jobs a live daemon would pick up
 * momentarily.
 */
export const DEFAULT_OVERDUE_GRACE_MS = 60_000;

/**
 * One job whose reset time has passed by more than the grace period yet is
 * still `waiting_for_reset`. In a healthy relay this set is empty; a non-empty
 * result is the clearest signal that jobs are due but nothing is resuming them.
 * Computed purely from the job list and an injected `now` (epoch ms) — no
 * clock, no queue, no I/O — so `agentrelay overdue` is unit-testable end to end.
 */
export interface OverdueEntry {
  /** The waiting job that should already have resumed. */
  job: RelayJob;
  /** Milliseconds `now` is past its reset time (always > graceMs, so > 0). */
  overdueByMs: number;
  /** 1-based position, most-overdue first (1 = has waited longest past due). */
  position: number;
}

/**
 * The overdue picture: every job past due beyond the grace period, worst first,
 * plus honest totals. Where `upcoming` shows the forward runway (what resumes
 * next), `overdue` looks backward at what should already be running — the
 * diagnostic half of the same timeline.
 */
export interface OverdueReport {
  /** Overdue jobs, most-overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The largest `overdueByMs` across all overdue jobs (0 when none). */
  worstOverdueMs: number;
  /** The grace period applied, echoed so callers can report the threshold. */
  graceMs: number;
}

/**
 * Order two overdue jobs worst-first: the one whose reset passed earliest (has
 * waited longest) comes first, then oldest `createdAt`, then id — fully
 * deterministic even when two jobs share a reset time.
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
 * Find the jobs that are overdue: `waiting_for_reset` jobs with a parseable
 * `resetAt` that `now` is past by more than the grace period. This is the same
 * set `upcoming`/`next` draw from, filtered to the ones the scheduler should
 * already have acted on — so a non-empty result means "due but not resuming".
 *
 * `graceMs` (default {@link DEFAULT_OVERDUE_GRACE_MS}) is clamped to >= 0; a
 * negative value is treated as 0. `limit` (a positive integer) trims the
 * returned `entries` to the worst N, but `totalOverdue`/`worstOverdueMs` still
 * reflect the full set so callers can honestly report "N more not shown".
 */
export function findOverdueJobs(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: { graceMs?: number; limit?: number } = {}
): OverdueReport {
  const graceMs = Math.max(0, options.graceMs ?? DEFAULT_OVERDUE_GRACE_MS);

  const overdue = jobs
    .filter((job) => {
      if (job.status !== "waiting_for_reset" || job.resetAt === null) return false;
      const resetMs = Date.parse(job.resetAt);
      if (Number.isNaN(resetMs)) return false;
      return now - resetMs > graceMs;
    })
    .sort(compareOverdue);

  const totalOverdue = overdue.length;
  const worstOverdueMs = totalOverdue > 0 ? now - Date.parse(overdue[0].resetAt as string) : 0;

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
    worstOverdueMs,
    graceMs,
  };
}
