import type { RelayJob } from "./types.js";

/**
 * One job that should already have resumed but is still parked in
 * `waiting_for_reset` with a `resetAt` in the past. Computed purely from the
 * job list and an injected `now` (epoch ms) — no clock, no queue, no I/O — so
 * `agentrelay overdue` is unit-testable end to end.
 */
export interface OverdueEntry {
  /** The overdue waiting job this row describes. */
  job: RelayJob;
  /** Milliseconds by which its reset time has already passed (always ≥ 0 here). */
  overdueByMs: number;
  /** 1-based position in the report, most overdue first. */
  position: number;
}

/**
 * The past-due mirror of the `upcoming` timeline. `upcoming` looks forward at
 * jobs that will resume; `overdue` looks backward at jobs whose reset time has
 * already come and gone while they sit in `waiting_for_reset`. A short overdue
 * span is normal (the scheduler resumes on its next tick), but jobs overdue by
 * minutes point at a stalled or stopped resume loop — surfaced here straight
 * from the job store, no daemon heartbeat required.
 */
export interface OverdueReport {
  /** Overdue rows, most overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The largest overdue span across all overdue jobs (0 when none). */
  worstOverdueByMs: number;
}

/**
 * Order two overdue jobs by how badly they are past due: the most overdue
 * (largest gap between `resetAt` and `now`) comes first, then oldest
 * `createdAt`, then id — so the ordering is fully deterministic even when two
 * jobs share a reset time.
 */
function compareOverdue(a: RelayJob, b: RelayJob, now: number): number {
  const oa = now - Date.parse(a.resetAt as string);
  const ob = now - Date.parse(b.resetAt as string);
  if (oa !== ob) return ob - oa;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the overdue report: the `waiting_for_reset` jobs whose parseable
 * `resetAt` is at least `minOverdueMs` in the past, sorted worst-first. This is
 * a subset of what `upcoming` reports as `dueNow`, but with the overdue span
 * made explicit so a threshold can separate "just came due" from "stuck".
 *
 * `minOverdueMs` (default 0) filters out jobs not yet overdue by that much —
 * use it to ignore the brief, harmless window right after a reset. `limit`
 * (when a positive integer) trims the returned `entries` to the worst N, but
 * `totalOverdue`/`worstOverdueByMs` still reflect the full set so callers can
 * honestly report "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: { minOverdueMs?: number; limit?: number } = {}
): OverdueReport {
  const minOverdueMs = typeof options.minOverdueMs === "number" && options.minOverdueMs > 0 ? options.minOverdueMs : 0;

  const overdue = jobs
    .filter((job) => {
      if (job.status !== "waiting_for_reset" || job.resetAt === null) return false;
      const resetMs = Date.parse(job.resetAt);
      if (Number.isNaN(resetMs)) return false;
      return now - resetMs >= minOverdueMs;
    })
    .sort((a, b) => compareOverdue(a, b, now));

  const totalOverdue = overdue.length;
  const worstOverdueByMs = totalOverdue > 0 ? now - Date.parse(overdue[0].resetAt as string) : 0;

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
