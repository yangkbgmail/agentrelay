import type { RelayJob } from "./types.js";

/**
 * One job whose reset time has already passed but which is still sitting in
 * `waiting_for_reset` — i.e. a scheduler tick *should* have resumed it by now
 * and hasn't. Computed purely from the job list and an injected `now` (epoch
 * ms) — no clock, no queue, no I/O — so `agentrelay overdue` is unit-testable
 * end to end.
 */
export interface OverdueEntry {
  /** The stuck job this row describes. */
  job: RelayJob;
  /** Milliseconds since its reset came due (always > graceMs; never negative). */
  overdueByMs: number;
  /** 1-based position, most-overdue first (1 = has been waiting the longest). */
  position: number;
}

/**
 * The overdue report: every `waiting_for_reset` job whose `resetAt` is more
 * than `graceMs` in the past, ordered worst-first. Where `upcoming` looks
 * *forward* ("what resumes next and when"), `overdue` looks *backward* to catch
 * the failure mode that timeline hides: a job that came due and was never
 * picked up — the daemon is stopped, crashed, or wedged.
 */
export interface OverdueReport {
  /** Overdue rows, most-overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The single worst overdue gap in ms (0 when nothing is overdue). */
  worstOverdueMs: number;
  /** The grace window (ms) below which a just-due job is *not* counted overdue. */
  graceMs: number;
}

/** Options for {@link buildOverdueReport}. */
export interface OverdueOptions {
  /**
   * Only flag a job once its reset is more than this many ms in the past.
   * Absorbs the scheduler's tick interval so a job that came due a few seconds
   * ago (and will be resumed on the next tick) isn't reported as stuck.
   * Defaults to 0 (any past-due waiting job counts). Negative values clamp to 0.
   */
  graceMs?: number;
  /** Show at most this many rows; totals still count the full set. */
  limit?: number;
}

/**
 * Order two overdue jobs worst-first: the one whose reset passed *earliest*
 * (largest overdue gap) comes first, then oldest `createdAt`, then id — fully
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
 * Build the overdue report: the `waiting_for_reset` jobs with a parseable
 * `resetAt` that is more than `graceMs` in the past, sorted worst-first. These
 * are exactly the jobs the scheduler's `listDue` would return *and* that have
 * been sitting there past the grace window — the signature of a resume loop
 * that isn't running.
 *
 * `limit` (when a positive integer) trims the returned `entries`, but
 * `totalOverdue`/`worstOverdueMs` still reflect the full set so callers can
 * honestly report "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: OverdueOptions = {}
): OverdueReport {
  const graceMs = Math.max(0, options.graceMs ?? 0);
  const { limit } = options;

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
