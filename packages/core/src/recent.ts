import type { RelayJob } from "./types.js";

/**
 * One row in the recent-activity feed: a job plus how long ago it was last
 * touched. Computed purely from the job list and an injected `now` (epoch ms) —
 * no clock, no queue, no I/O — so `agentrelay recent` is unit-testable end to
 * end.
 */
export interface RecentEntry {
  /** The job this row describes. */
  job: RelayJob;
  /**
   * Milliseconds from the job's `updatedAt` to `now` (how long ago it last
   * changed state). `null` when `updatedAt` can't be parsed, so callers can
   * render a placeholder instead of a bogus duration.
   */
  ageMs: number | null;
  /** 1-based position in the feed (1 = most recently touched). */
  position: number;
}

/**
 * The backward-looking activity feed: every job ordered by when it last
 * changed state, most recent first. Where `next`/`upcoming`/`overdue` all look
 * at the *reset* axis (what the relay will do, and when), `recent` looks at the
 * *activity* axis — what the relay has actually been doing lately, across every
 * status. This is the "what just happened?" view nothing else provides.
 */
export interface RecentActivity {
  /** Ordered rows, most-recently-touched first. Trimmed to `limit` when given. */
  entries: RecentEntry[];
  /** Total number of jobs considered (before any `limit` trim). */
  total: number;
  /** How many jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
}

/**
 * Order two jobs by recency of their last state change: newest `updatedAt`
 * first, then newest `createdAt`, then id ascending — so the ordering is fully
 * deterministic even when two jobs share an `updatedAt`. Jobs whose `updatedAt`
 * can't be parsed sort to the bottom (they can't be placed on the timeline),
 * but are still listed so the feed never silently drops a job.
 */
function compareRecent(a: RelayJob, b: RelayJob): number {
  const ua = Date.parse(a.updatedAt);
  const ub = Date.parse(b.updatedAt);
  const aBad = Number.isNaN(ua);
  const bBad = Number.isNaN(ub);
  if (aBad !== bBad) return aBad ? 1 : -1; // unparseable timestamps go last
  if (!aBad && !bBad && ua !== ub) return ub - ua; // newer updatedAt first
  const ca = Date.parse(a.createdAt);
  const cb = Date.parse(b.createdAt);
  if (!Number.isNaN(ca) && !Number.isNaN(cb) && ca !== cb) return cb - ca; // newer createdAt first
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the recent-activity feed: all jobs ordered by when they last changed
 * state, most recent first. Unlike the reset-axis views this spans every
 * status, so a completed job that just finished and a queued job that was just
 * enqueued both show up — sorted purely by recency.
 *
 * `limit` (when a non-negative integer) trims the returned `entries` to the
 * most-recent N, but `total` still reflects the full set so callers can
 * honestly report "N more not shown".
 */
export function buildRecentActivity(jobs: RelayJob[], now: number = Date.now(), limit?: number): RecentActivity {
  const ordered = [...jobs].sort(compareRecent);
  const total = ordered.length;

  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? ordered.slice(0, limit) : ordered;

  const entries: RecentEntry[] = capped.map((job, index) => {
    const updatedMs = Date.parse(job.updatedAt);
    return {
      job,
      ageMs: Number.isNaN(updatedMs) ? null : now - updatedMs,
      position: index + 1,
    };
  });

  return {
    entries,
    total,
    hidden: total - entries.length,
  };
}
