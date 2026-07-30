import type { RelayJob } from "./types.js";

/**
 * One waiting job whose reset time has already passed but which is still sitting
 * in `waiting_for_reset` — i.e. a scheduler tick *should* have picked it up by
 * now but hasn't. Computed purely from the job list and an injected `now` (epoch
 * ms) — no clock, no queue, no I/O — so `agentrelay overdue` is unit-testable
 * end to end.
 */
export interface OverdueEntry {
  /** The waiting job whose resume is late. */
  job: RelayJob;
  /** Milliseconds by which its reset time is already in the past (always > 0). */
  overdueByMs: number;
  /** 1-based position in the report (1 = most overdue). */
  position: number;
}

/**
 * The jobs the relay is *late* on: every `waiting_for_reset` job whose `resetAt`
 * has passed but which is still waiting. Where `upcoming` shows the forward
 * runway (what resumes next and when), `overdue` is the diagnostic mirror — any
 * non-empty result means the resume loop is behind, usually because the
 * daemon/tick isn't running (see `agentrelay doctor`/`health`). An empty report
 * is the healthy state.
 */
export interface OverdueReport {
  /** Rows, most-overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The largest `overdueByMs` across the full set (0 when none are overdue). */
  maxOverdueByMs: number;
}

/**
 * Order two overdue jobs by how late they are: the earliest `resetAt` (longest
 * overdue) comes first, then oldest `createdAt`, then id — fully deterministic
 * even when two jobs share a reset time. Mirrors `upcoming`'s tie-break so the
 * two views order the same jobs consistently (upcoming ascends toward the
 * future; overdue reads the already-past tail of that same order).
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
 * `resetAt` that is at or before `now`, sorted most-overdue first. This is the
 * subset of the scheduler's due list that has been due *without being resumed*,
 * so a non-empty report is the clearest per-job signal that "jobs are queued but
 * nothing is resuming them" — the failure the whole relay exists to prevent.
 *
 * `limit` (when a non-negative integer) trims the returned `entries` to the
 * most-overdue N, but `totalOverdue`/`maxOverdueByMs` still reflect the full set
 * so callers can honestly report "N more not shown".
 */
export function buildOverdueReport(jobs: RelayJob[], now: number = Date.now(), limit?: number): OverdueReport {
  const overdue = jobs
    .filter(
      (job) =>
        job.status === "waiting_for_reset" &&
        job.resetAt !== null &&
        !Number.isNaN(Date.parse(job.resetAt)) &&
        Date.parse(job.resetAt) <= now
    )
    .sort(compareOverdue);

  const totalOverdue = overdue.length;
  const maxOverdueByMs = totalOverdue === 0 ? 0 : now - Date.parse(overdue[0].resetAt as string);

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
    maxOverdueByMs,
  };
}
