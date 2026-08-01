import type { RelayJob } from "./types.js";

/**
 * One `waiting_for_reset` job whose reset time has already passed by more than
 * the grace window — i.e. a scheduler tick *should* have resumed it by now but
 * apparently hasn't. Computed purely from the job list and an injected `now`
 * (epoch ms) — no clock, no queue, no I/O — so `agentrelay overdue` is
 * unit-testable end to end.
 */
export interface OverdueEntry {
  /** The stuck waiting job this row describes. */
  job: RelayJob;
  /** How long ago the reset time passed, in ms (always > graceMs). */
  overdueByMs: number;
}

/**
 * The set of resumes the relay has fallen behind on: `waiting_for_reset` jobs
 * whose `resetAt` is further in the past than `graceMs`. Where `upcoming` shows
 * the forward runway and `next` the single next move, `overdue` answers the
 * opposite, diagnostic question — "what should already be running but isn't?".
 * A non-empty report almost always means the resume loop (daemon/tick) is down,
 * or the agent binary can't spawn; a healthy relay keeps this empty.
 */
export interface OverdueReport {
  /** Overdue rows, most-overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** Total overdue jobs before any `limit` trim. */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The grace window applied, in ms (jobs due within it are not yet overdue). */
  graceMs: number;
  /** The worst single overdue span in ms (0 when nothing is overdue). */
  maxOverdueByMs: number;
}

/** Options for {@link buildOverdueReport}. */
export interface OverdueOptions {
  /**
   * Only flag jobs whose reset passed more than this many ms ago. Guards
   * against false alarms for jobs that just came due within a poll cycle or
   * two. Defaults to 0 (any past-due waiting job counts). Negative/non-finite
   * values are treated as 0.
   */
  graceMs?: number;
  /** Show at most this many entries; totals still count them all. */
  limit?: number;
}

/**
 * Order two overdue jobs worst-first: the one that has been overdue longest
 * comes first, then oldest `createdAt`, then id — fully deterministic even when
 * two jobs share a reset time. Newest-overdue is the tie-break's back, so the
 * ranking surfaces the most-stuck job at the top where it belongs.
 */
function compareOverdue(a: RelayJob, b: RelayJob): number {
  const ra = Date.parse(a.resetAt as string);
  const rb = Date.parse(b.resetAt as string);
  // Earlier resetAt = longer overdue = should sort first.
  if (ra !== rb) return ra - rb;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the overdue report: every `waiting_for_reset` job with a parseable
 * `resetAt` that came due more than `graceMs` ago, ranked most-overdue first.
 * This reads exactly the set the scheduler's `listDue` would act on, so a
 * populated report is a faithful "the daemon has these ready but isn't running
 * them" signal rather than a re-derivation of due logic.
 *
 * `limit` (a positive integer) trims the returned `entries`, but
 * `totalOverdue`/`maxOverdueByMs` still reflect the full set so callers can
 * honestly report "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: OverdueOptions = {}
): OverdueReport {
  const graceMs = Number.isFinite(options.graceMs) && (options.graceMs as number) > 0 ? (options.graceMs as number) : 0;

  const overdue = jobs
    .filter((job) => {
      if (job.status !== "waiting_for_reset" || job.resetAt === null) return false;
      const resetMs = Date.parse(job.resetAt);
      if (Number.isNaN(resetMs)) return false;
      return now - resetMs > graceMs;
    })
    .sort(compareOverdue);

  const totalOverdue = overdue.length;
  const { limit } = options;
  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? overdue.slice(0, limit) : overdue;

  const entries: OverdueEntry[] = capped.map((job) => ({
    job,
    overdueByMs: now - Date.parse(job.resetAt as string),
  }));

  const maxOverdueByMs = totalOverdue > 0 ? now - Date.parse(overdue[0].resetAt as string) : 0;

  return {
    entries,
    totalOverdue,
    hidden: totalOverdue - entries.length,
    graceMs,
    maxOverdueByMs,
  };
}
