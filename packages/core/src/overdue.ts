import type { RelayJob } from "./types.js";

/**
 * Default grace period (ms) before a due job is considered *overdue*. A healthy
 * relay loop polls every 30s by default, so a job whose reset passed only
 * seconds ago is simply "due this tick", not stuck. Only once it has been past
 * due for longer than this window does its continued `waiting_for_reset` state
 * become evidence that nothing is resuming it (a dead daemon, a missing cron).
 */
export const DEFAULT_OVERDUE_GRACE_MS = 60_000;

/**
 * One overdue job: a `waiting_for_reset` job whose reset time passed more than
 * the grace window ago yet is still sitting in the queue. Computed purely from
 * the job list and an injected `now` (epoch ms) — no clock, no queue, no I/O —
 * so `agentrelay overdue` is unit-testable end to end.
 */
export interface OverdueEntry {
  /** The overdue job this row describes. */
  job: RelayJob;
  /** How long ago the reset time passed (ms, always >= the grace window). */
  overdueByMs: number;
  /** 1-based rank in the report; 1 = the most overdue (longest past due). */
  position: number;
}

/**
 * The jobs the relay *should* already have resumed but hasn't. Where `upcoming`
 * looks forward at what's still pending and `next` at the single next move,
 * `overdue` looks backward at what has slipped: waiting jobs whose reset passed
 * more than the grace window ago. A non-empty report with a live daemon means
 * something is wrong; with no daemon it's the exact list a `tick` would clear.
 */
export interface OverdueReport {
  /** Overdue rows, most-overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The longest any job has been overdue (ms); 0 when nothing is overdue. */
  longestOverdueMs: number;
  /** The grace window (ms) used to decide overdue-ness, echoed for the caller. */
  graceMs: number;
}

/**
 * Order two overdue jobs longest-overdue first. Since `now` is fixed for a
 * report, the earliest `resetAt` is the most overdue, so this is `resetAt`
 * ascending with `createdAt` then id as deterministic tie-breaks — the same
 * tie-break `next`/`upcoming` use, so shared reset times sort identically
 * across all three surfaces.
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
 * Build the overdue report: `waiting_for_reset` jobs with a parseable `resetAt`
 * that passed more than `graceMs` ago, ranked most-overdue first. This is the
 * subset of `upcoming`'s "due now" jobs that a healthy loop would already have
 * cleared, so a non-empty result is a direct, store-only signal of a stalled
 * resume loop — no heartbeat file required.
 *
 * `options.graceMs` (default {@link DEFAULT_OVERDUE_GRACE_MS}) is clamped to
 * a non-negative number; `0` reports every due job. `options.limit` (a positive
 * integer) trims the returned `entries`, but `totalOverdue`/`longestOverdueMs`
 * still reflect the full set so callers can honestly report "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: { graceMs?: number; limit?: number } = {}
): OverdueReport {
  const graceMs =
    typeof options.graceMs === "number" && Number.isFinite(options.graceMs) && options.graceMs >= 0
      ? options.graceMs
      : DEFAULT_OVERDUE_GRACE_MS;
  const cutoff = now - graceMs;

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
  const longestOverdueMs = totalOverdue > 0 ? now - Date.parse(overdue[0].resetAt as string) : 0;

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
    longestOverdueMs,
    graceMs,
  };
}
