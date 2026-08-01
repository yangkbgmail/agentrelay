import type { RelayJob } from "./types.js";

/**
 * One overdue job: a `waiting_for_reset` job whose reset time has already
 * passed yet is still sitting in the queue instead of being resumed. Computed
 * purely from the job list and an injected `now` (epoch ms) — no clock, no
 * queue, no I/O — so `agentrelay overdue` is unit-testable end to end.
 */
export interface OverdueEntry {
  /** The waiting job whose reset time is in the past. */
  job: RelayJob;
  /** How long ago the reset time passed, in ms (always > 0 for a listed entry). */
  overdueByMs: number;
  /** 1-based position in the report, most-overdue first (1 = longest stuck). */
  position: number;
}

/**
 * The set of jobs that *should* have resumed by now but haven't. Where
 * `upcoming` looks forward at what's still counting down, `overdue` looks at
 * the backlog that has already come due — the single strongest signal that the
 * resume loop (daemon/tick) is absent or stuck, since a healthy loop drains
 * these on its next pass. Pairs with `health`/`doctor`: they answer "is the
 * loop alive?", `overdue` answers "which specific jobs is it failing to move?".
 */
export interface OverdueReport {
  /** Overdue rows, longest-overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The grace threshold applied (ms); a job counts as overdue only past this. */
  minOverdueMs: number;
}

/** Options for {@link buildOverdueReport}. */
export interface OverdueOptions {
  /**
   * Grace period (ms) before a past-due job counts as overdue. A momentarily
   * due job that a scheduler tick will pick up within its poll interval isn't
   * "stuck", so callers can pass e.g. two poll intervals to filter out the
   * normal churn and surface only genuinely late resumes. Default 0 (report
   * every past-due job). Negative/non-finite values are treated as 0.
   */
  minOverdueMs?: number;
  /** Show at most this many rows; totals still reflect the full overdue set. */
  limit?: number;
}

/**
 * Order two overdue jobs by how stuck they are: the earliest reset time (the
 * longest-overdue job) comes first, then oldest `createdAt`, then id — so the
 * ordering is fully deterministic even when two jobs share a reset time. This
 * is the reverse-urgency mirror of `upcoming`'s soonest-first ordering, but the
 * tie-break chain is identical so the two commands stay consistent.
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
 * `resetAt` at least `minOverdueMs` in the past, sorted longest-overdue first.
 * This is exactly the subset of the scheduler's due set that a running loop
 * should already have drained, so a non-empty report while the daemon is up
 * points at a real resume failure rather than normal timing.
 *
 * `limit` (when a non-negative integer) trims the returned `entries` to the
 * most-overdue N, but `totalOverdue` still reflects the full set so callers can
 * honestly report "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: OverdueOptions = {}
): OverdueReport {
  const minOverdueMs =
    typeof options.minOverdueMs === "number" && Number.isFinite(options.minOverdueMs) && options.minOverdueMs > 0
      ? options.minOverdueMs
      : 0;
  const cutoff = now - minOverdueMs;

  const overdue = jobs
    .filter(
      (job) =>
        job.status === "waiting_for_reset" &&
        job.resetAt !== null &&
        !Number.isNaN(Date.parse(job.resetAt)) &&
        Date.parse(job.resetAt) <= cutoff
    )
    .sort(compareOverdue);

  const totalOverdue = overdue.length;
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
    minOverdueMs,
  };
}
