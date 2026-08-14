import type { JobStatus, RelayJob } from "./types.js";

/**
 * The terminal statuses a job can finish in. Kept in step with
 * `stats.TERMINAL_STATUSES` — `recent` is the "what just resolved?" mirror of
 * the forward-looking `upcoming` timeline, so it only shows jobs that have
 * reached one of these end states.
 */
const RECENT_TERMINAL_STATUSES: JobStatus[] = ["completed", "failed", "cancelled"];

/**
 * One finished job in the recent-activity feed, plus the context the CLI needs
 * to render a row. Computed purely from the job list and an injected `now`
 * (epoch ms) — no clock, no queue, no I/O — so `agentrelay recent` is
 * unit-testable end to end.
 */
export interface RecentEntry {
  /** The finished job this row describes. */
  job: RelayJob;
  /**
   * Lifecycle span `updatedAt - createdAt` in ms — how long the relay watched
   * this job before it resolved. Null when either timestamp is
   * missing/unparseable or the span is negative (clock skew), matching the
   * `stats` "resolution time" convention.
   */
  resolutionMs: number | null;
  /** Milliseconds from when it finished (`updatedAt`) until `now`; never negative. */
  finishedAgoMs: number;
  /** 1-based position in the feed (1 = most recently finished). */
  position: number;
}

/**
 * The backward-looking feed of jobs the relay has already resolved, newest
 * finish first. Where `upcoming` shows what's queued to resume and when,
 * `recent` answers "what did the relay just finish while I was away?" — the
 * past corner of the `next`/`upcoming`/`overdue`/`eta` timeline family.
 */
export interface RecentReport {
  /** Ordered rows, most-recently-finished first. Trimmed to `limit` when one was given. */
  entries: RecentEntry[];
  /** How many terminal (finished) jobs there are in total (before any `limit` trim). */
  totalResolved: number;
  /** How many finished jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /**
   * Mean resolution span across the full resolved set (only jobs with a
   * well-formed, non-negative span count), rounded to whole ms. Null when no
   * finished job has a usable span. Computed over the whole set, not just the
   * shown rows, so it stays honest under `--limit`.
   */
  avgResolutionMs: number | null;
}

/**
 * Lifecycle span of a job in ms (`updatedAt - createdAt`), or null when either
 * timestamp is missing/unparseable or the span is negative (clock skew). Same
 * rule `stats` uses for resolution time.
 */
function resolutionMs(job: RelayJob): number | null {
  const created = Date.parse(job.createdAt);
  const updated = Date.parse(job.updatedAt);
  if (Number.isNaN(created) || Number.isNaN(updated)) return null;
  const span = updated - created;
  return span >= 0 ? span : null;
}

/** The finish time (`updatedAt`) as epoch ms, or -Infinity when unparseable so it sinks to the bottom. */
function finishedAtMs(job: RelayJob): number {
  const t = Date.parse(job.updatedAt);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * Order two finished jobs newest-finish first: latest `updatedAt` wins, then
 * newest `createdAt`, then id — so the ordering is fully deterministic even
 * when two jobs share a finish time. Jobs whose `updatedAt` can't be parsed
 * sort to the end (they can't be placed on the timeline).
 */
function compareRecent(a: RelayJob, b: RelayJob): number {
  const fa = finishedAtMs(a);
  const fb = finishedAtMs(b);
  if (fa !== fb) return fb - fa;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the recent-activity feed: the terminal (completed/failed/cancelled)
 * jobs, most recently finished first, each annotated with how long the relay
 * watched it (`resolutionMs`) and how long ago it finished (`finishedAgoMs`).
 *
 * `limit` (when a non-negative integer) trims the returned `entries` to the
 * newest N, but `totalResolved`/`avgResolutionMs` still reflect the full set so
 * callers can honestly report "N more not shown" and a stable average.
 */
export function buildRecentReport(jobs: RelayJob[], now: number = Date.now(), limit?: number): RecentReport {
  const resolved = jobs.filter((job) => RECENT_TERMINAL_STATUSES.includes(job.status)).sort(compareRecent);

  const totalResolved = resolved.length;
  const spans = resolved.map(resolutionMs).filter((n): n is number => n !== null);
  const avgResolutionMs = spans.length > 0 ? Math.round(spans.reduce((sum, n) => sum + n, 0) / spans.length) : null;

  const capped =
    typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? resolved.slice(0, limit) : resolved;

  const entries: RecentEntry[] = capped.map((job, index) => {
    const finishedAt = Date.parse(job.updatedAt);
    return {
      job,
      resolutionMs: resolutionMs(job),
      finishedAgoMs: Number.isNaN(finishedAt) ? 0 : Math.max(0, now - finishedAt),
      position: index + 1,
    };
  });

  return {
    entries,
    totalResolved,
    hidden: totalResolved - entries.length,
    avgResolutionMs,
  };
}
