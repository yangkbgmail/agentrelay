import type { RelayJob } from "./types.js";

/**
 * One `waiting_for_reset` job that is past its reset time by more than the
 * grace window — i.e. a scheduler tick *should* have resumed it already but
 * hasn't. Computed purely from the job list plus an injected `now` (epoch ms)
 * and grace window — no clock, no queue, no I/O — so `agentrelay overdue` is
 * unit-testable end to end.
 */
export interface OverdueEntry {
  /** The overdue waiting job this row describes. */
  job: RelayJob;
  /** Milliseconds `now` is past the job's reset time (always > graceMs). */
  overdueByMs: number;
  /** 1-based position, most-overdue first (1 = the job that's been due longest). */
  position: number;
}

/**
 * The set of resumes the relay is *behind* on: `waiting_for_reset` jobs whose
 * reset time passed more than the grace window ago. Where `upcoming` shows the
 * forward runway (what resumes next), `overdue` looks backward at what should
 * already have run — the clearest signal that the resume loop (daemon/tick) is
 * down or stuck, since a healthy loop drains due jobs within a poll interval.
 */
export interface OverdueReport {
  /** Overdue rows, most-overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The largest `overdueByMs` across all overdue jobs (0 when none). */
  worstOverdueByMs: number;
  /** The grace window (ms) used to decide "overdue"; echoed so callers can report it. */
  graceMs: number;
}

/** Default grace window for `overdue`: none — any job past its reset counts. */
export const DEFAULT_OVERDUE_GRACE_MS = 0;

/**
 * Order two overdue jobs by which has been due longest: earliest reset time
 * wins (most overdue first), then oldest `createdAt`, then id — so the ordering
 * is fully deterministic even when two jobs share a reset time. The earliest
 * `resetAt` is exactly the most-overdue job, so this is the reverse-priority
 * view of the same order `next`/`upcoming` use.
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
 * `resetAt` whose reset passed more than `graceMs` ago, sorted most-overdue
 * first. This is the same due-job set the scheduler's `listDue` acts on,
 * narrowed to the ones a healthy loop would already have drained — so a
 * non-empty report with the daemon "up" points at a stuck loop, and with the
 * daemon down points at nothing running at all.
 *
 * `graceMs` (default {@link DEFAULT_OVERDUE_GRACE_MS}) suppresses jobs that
 * only just came due, since a loop legitimately takes up to a poll interval to
 * pick them up; negative/NaN grace is clamped to 0. `limit` (a positive
 * integer) trims the returned `entries` to the N most overdue, but
 * `totalOverdue`/`worstOverdueByMs` still reflect the full set so callers can
 * honestly report "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: { limit?: number; graceMs?: number } = {}
): OverdueReport {
  const graceMs =
    typeof options.graceMs === "number" && Number.isFinite(options.graceMs) && options.graceMs > 0
      ? options.graceMs
      : 0;

  const overdue = jobs
    .filter((job) => {
      if (job.status !== "waiting_for_reset" || job.resetAt === null) return false;
      const resetMs = Date.parse(job.resetAt);
      if (Number.isNaN(resetMs)) return false;
      return now - resetMs > graceMs;
    })
    .sort(compareOverdue);

  const totalOverdue = overdue.length;
  const worstOverdueByMs = totalOverdue > 0 ? now - Date.parse(overdue[0].resetAt as string) : 0;

  const capped =
    typeof options.limit === "number" && Number.isInteger(options.limit) && options.limit >= 0
      ? overdue.slice(0, options.limit)
      : overdue;

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
    graceMs,
  };
}
