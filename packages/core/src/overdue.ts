import type { RelayJob } from "./types.js";

/**
 * One waiting job whose reset time has already passed but which is still stuck
 * in `waiting_for_reset` — i.e. the resume loop should have picked it up by now
 * and hasn't. Computed purely from the job list and an injected `now` (epoch
 * ms) — no clock, no queue, no I/O — so `agentrelay overdue` is unit-testable
 * end to end.
 */
export interface OverdueEntry {
  /** The overdue waiting job this row describes. */
  job: RelayJob;
  /** How long (ms) the reset has been in the past — always positive. */
  overdueByMs: number;
  /** 1-based position in the report (1 = most overdue). */
  position: number;
}

/**
 * The backward-looking companion to `upcoming`: every `waiting_for_reset` job
 * whose `resetAt` has already passed (by more than an optional grace window),
 * ranked most-overdue first. Where `upcoming` shows the runway ahead, `overdue`
 * answers "the daemon should have resumed these already — how far behind is it?"
 * A non-empty report almost always means the resume loop is down, lagging, or
 * pointed at the wrong store.
 */
export interface OverdueReport {
  /** Rows, most-overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** Longest lateness (ms) across the full overdue set; 0 when none are overdue. */
  maxOverdueByMs: number;
}

/** Options for {@link buildOverdueReport}. */
export interface OverdueOptions {
  /** When a positive integer, trim `entries` to the N most overdue. */
  limit?: number;
  /**
   * A job counts as overdue only once its reset is more than this many ms in
   * the past. Defaults to 0 (any past-due job counts). Use a small grace (e.g.
   * one poll interval) to avoid flagging jobs that are only seconds late and
   * about to be resumed on the next tick.
   */
  graceMs?: number;
}

/**
 * Order two overdue jobs by how late they are: the earliest reset (longest
 * overdue) wins, then oldest `createdAt`, then id — fully deterministic even
 * when two jobs share a reset time. This is the mirror of `upcoming`'s ordering
 * (which puts soonest-due first): the same key, reversed in meaning because
 * every job here is already in the past.
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
 * `resetAt` that is more than `graceMs` in the past, ranked most-overdue first.
 * These are exactly the jobs a healthy scheduler would have already resumed, so
 * a non-empty report is the clearest "the relay isn't resuming" signal there is.
 *
 * `limit` (when a positive integer) trims the returned `entries` to the N most
 * overdue, but `totalOverdue`/`maxOverdueByMs` still reflect the full set so
 * callers can honestly report "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: OverdueOptions = {}
): OverdueReport {
  const graceMs = typeof options.graceMs === "number" && options.graceMs > 0 ? options.graceMs : 0;
  const limit = options.limit;

  const overdue = jobs
    .filter(
      (job) =>
        job.status === "waiting_for_reset" &&
        job.resetAt !== null &&
        !Number.isNaN(Date.parse(job.resetAt)) &&
        now - Date.parse(job.resetAt) > graceMs
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
