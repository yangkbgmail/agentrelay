import { TERMINAL_STATUSES } from "./stats.js";
import type { RelayJob } from "./types.js";

/**
 * One recently-resolved job in the activity feed, plus the two spans the CLI
 * renders: how long ago it reached its terminal state, and how long the relay
 * looked after it from creation to that state. Computed purely from the job
 * list and an injected `now` (epoch ms) — no clock, no queue, no I/O — so
 * `agentrelay recent` is unit-testable end to end.
 */
export interface RecentEntry {
  /** The terminal (completed/failed/cancelled) job this row describes. */
  job: RelayJob;
  /**
   * Milliseconds since `updatedAt` — i.e. how long ago the job reached its
   * terminal state. Clamped to ≥ 0 (a future `updatedAt` from clock skew reads
   * as "just now"). `null` when `updatedAt` is unparseable.
   */
  ageMs: number | null;
  /**
   * Lifecycle span `updatedAt − createdAt` in ms — how long the relay babysat
   * the job before it resolved. `null` when either timestamp is unparseable or
   * the span is negative (clock skew), matching `TimingStats`'s skip-don't-clamp
   * policy so a bogus timestamp never inflates the feed.
   */
  resolutionMs: number | null;
}

/**
 * The rear-view mirror of the temporal-view family. Where `next`/`upcoming`
 * look forward at what will resume and `overdue` flags what is stuck, `recent`
 * looks *back* at what the relay has actually resolved lately — the completed,
 * failed, and cancelled jobs, most-recent-first — so you can answer "what just
 * happened?" at a glance without scanning the whole `status` table.
 */
export interface RecentReport {
  /** Resolved rows, most-recent-first. Trimmed to `limit` when one was given. */
  entries: RecentEntry[];
  /** Total resolved (terminal) jobs before any `limit` trim. */
  total: number;
  /** How many resolved jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
}

/** Options for {@link buildRecentActivity}. */
export interface RecentOptions {
  /** Show at most this many entries; `total`/`hidden` still count them all. */
  limit?: number;
}

const TERMINAL_SET = new Set<RelayJob["status"]>(TERMINAL_STATUSES);

/**
 * Order two resolved jobs newest-activity-first: latest `updatedAt` wins, then
 * newest `createdAt`, then id — fully deterministic even when two jobs share a
 * terminal timestamp. An unparseable `updatedAt` sorts to the back (treated as
 * oldest) rather than throwing, so one bad record can't reorder the feed.
 */
function compareRecent(a: RelayJob, b: RelayJob): number {
  const ua = Date.parse(a.updatedAt);
  const ub = Date.parse(b.updatedAt);
  const va = Number.isNaN(ua) ? Number.NEGATIVE_INFINITY : ua;
  const vb = Number.isNaN(ub) ? Number.NEGATIVE_INFINITY : ub;
  if (va !== vb) return vb - va; // newest updatedAt first
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1; // newest createdAt first
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the recent-activity report: every terminal (completed/failed/cancelled)
 * job, ordered by when it last changed, most-recent-first. This reads only the
 * settled jobs — the ones the relay is done with — so it never overlaps
 * `upcoming`/`overdue` (which read the still-waiting set).
 *
 * `limit` (a non-negative integer) trims the returned `entries`, but `total`
 * still reflects the full resolved set so callers can honestly report "N more
 * not shown".
 */
export function buildRecentActivity(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: RecentOptions = {}
): RecentReport {
  const resolved = jobs.filter((job) => TERMINAL_SET.has(job.status)).sort(compareRecent);

  const total = resolved.length;
  const { limit } = options;
  const capped =
    typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? resolved.slice(0, limit) : resolved;

  const entries: RecentEntry[] = capped.map((job) => {
    const updated = Date.parse(job.updatedAt);
    const created = Date.parse(job.createdAt);
    const ageMs = Number.isNaN(updated) ? null : Math.max(0, now - updated);
    const span = Number.isNaN(updated) || Number.isNaN(created) ? null : updated - created;
    const resolutionMs = span === null || span < 0 ? null : span;
    return { job, ageMs, resolutionMs };
  });

  return { entries, total, hidden: total - entries.length };
}
