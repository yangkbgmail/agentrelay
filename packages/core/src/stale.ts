import type { RelayJob } from "./types.js";

/**
 * One `resuming` job that has sat in that in-flight state longer than the
 * staleness threshold — i.e. a scheduler tick *started* resuming it (spawned the
 * agent command) but never reached a terminal state (completed/failed) or
 * re-queued it. The tell-tale of a resume that crashed or hung: the daemon died
 * mid-spawn, the child wedged, or the process was killed before it could record
 * the outcome. Computed purely from the job list and an injected `now`
 * (epoch ms) — no clock, no queue, no I/O — so `agentrelay stale` is
 * unit-testable end to end.
 */
export interface StaleEntry {
  /** The stuck `resuming` job this row describes. */
  job: RelayJob;
  /** How long the job has been parked in `resuming`, in ms (always > thresholdMs). */
  stuckForMs: number;
}

/**
 * The set of resumes that got wedged: `resuming` jobs whose `updatedAt` (the
 * moment the scheduler flipped them to `resuming`) is further in the past than
 * `thresholdMs`. Where `overdue` catches jobs that should have *started* but
 * didn't (still `waiting_for_reset`), `stale` catches the opposite failure mode
 * — jobs that *did* start resuming but never finished. A non-empty report almost
 * always means a resume crashed or a child process hung; a healthy relay drains
 * `resuming` jobs to a terminal state within seconds/minutes and keeps this empty.
 */
export interface StaleReport {
  /** Stale rows, longest-stuck first. Trimmed to `limit` when one was given. */
  entries: StaleEntry[];
  /** Total stale jobs before any `limit` trim. */
  totalStale: number;
  /** How many stale jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The staleness threshold applied, in ms (resuming jobs younger than it are ignored). */
  thresholdMs: number;
  /** The worst single stuck span in ms (0 when nothing is stale). */
  maxStuckForMs: number;
}

/** Options for {@link buildStaleReport}. */
export interface StaleOptions {
  /**
   * Only flag `resuming` jobs that have been in that state longer than this many
   * ms. Guards against false alarms for resumes that are legitimately still
   * running (an agent command can take a while). Defaults to 0 (any resuming job
   * counts). Negative/non-finite values are treated as 0.
   */
  thresholdMs?: number;
  /** Show at most this many entries; totals still count them all. */
  limit?: number;
}

/**
 * Order two stale jobs longest-stuck-first: the one that entered `resuming`
 * earliest (oldest `updatedAt`) comes first, then oldest `createdAt`, then id —
 * fully deterministic even when two jobs share an `updatedAt`. Mirrors the
 * `overdue` ordering so the two diagnostic commands feel identical.
 */
function compareStale(a: RelayJob, b: RelayJob): number {
  const ua = Date.parse(a.updatedAt);
  const ub = Date.parse(b.updatedAt);
  // Earlier updatedAt = longer stuck = should sort first.
  if (ua !== ub) return ua - ub;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the stale report: every `resuming` job with a parseable `updatedAt`
 * that has been stuck for more than `thresholdMs`, ranked longest-stuck first.
 * This reads exactly the in-flight set the scheduler owns, so a populated report
 * is a faithful "these resumes started but never finished" signal.
 *
 * `limit` (a non-negative integer) trims the returned `entries`, but
 * `totalStale`/`maxStuckForMs` still reflect the full set so callers can
 * honestly report "N more not shown".
 */
export function buildStaleReport(jobs: RelayJob[], now: number = Date.now(), options: StaleOptions = {}): StaleReport {
  const thresholdMs =
    Number.isFinite(options.thresholdMs) && (options.thresholdMs as number) > 0 ? (options.thresholdMs as number) : 0;

  const stale = jobs
    .filter((job) => {
      if (job.status !== "resuming") return false;
      const updatedMs = Date.parse(job.updatedAt);
      if (Number.isNaN(updatedMs)) return false;
      return now - updatedMs > thresholdMs;
    })
    .sort(compareStale);

  const totalStale = stale.length;
  const { limit } = options;
  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? stale.slice(0, limit) : stale;

  const entries: StaleEntry[] = capped.map((job) => ({
    job,
    stuckForMs: now - Date.parse(job.updatedAt),
  }));

  const maxStuckForMs = totalStale > 0 ? now - Date.parse(stale[0].updatedAt) : 0;

  return {
    entries,
    totalStale,
    hidden: totalStale - entries.length,
    thresholdMs,
    maxStuckForMs,
  };
}
