import { TERMINAL_STATUSES } from "./stats.js";
import type { JobStatus, RelayJob } from "./types.js";

/**
 * One recently *resolved* job — i.e. one that has reached a terminal state
 * (`completed`/`failed`/`cancelled`). Computed purely from the job list and an
 * injected `now` (epoch ms) — no clock, no queue, no I/O — so
 * `agentrelay recent` is unit-testable end to end.
 */
export interface RecentEntry {
  /** The terminal job this row describes. */
  job: RelayJob;
  /** When the job reached its terminal state, in epoch ms (from `updatedAt`). */
  resolvedAt: number;
  /** How long ago it resolved, in ms (`now - resolvedAt`, clamped to ≥ 0). */
  ageMs: number;
  /**
   * Lifecycle span `updatedAt - createdAt` in ms — how long the relay looked
   * after the job before it resolved — or null when either timestamp is
   * unparseable or the span is negative (clock skew).
   */
  resolutionMs: number | null;
}

/** Terminal-outcome tally over the (scoped) store, independent of `limit`. */
export interface RecentOutcomeCounts {
  completed: number;
  failed: number;
  cancelled: number;
}

/**
 * The backward-looking companion to `upcoming`/`overdue`: what the relay has
 * most-recently *finished*. Where `upcoming` shows the forward runway and
 * `overdue` the resumes it fell behind on, `recent` answers "what just
 * happened?" — the last N jobs to reach a terminal state, newest first, with
 * how long ago and how long each took.
 */
export interface RecentReport {
  /** Recent rows, most-recently-resolved first. Trimmed to `limit` when given. */
  entries: RecentEntry[];
  /** Total terminal jobs in the (scoped) store before any `limit`/`within` trim. */
  totalTerminal: number;
  /** How many terminal jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** Outcome tally over the full matched set (before `limit`, after `within`). */
  byOutcome: RecentOutcomeCounts;
  /** The resolution-age window applied, in ms, or null when unbounded. */
  withinMs: number | null;
}

/** Options for {@link buildRecentReport}. */
export interface RecentOptions {
  /** Show at most this many entries; the totals still count them all. */
  limit?: number;
  /**
   * Only include jobs that resolved within the last N ms (by `updatedAt`).
   * Guards a huge store to just the recent tail. Non-finite/non-positive
   * values mean "unbounded" (every terminal job qualifies).
   */
  withinMs?: number;
}

/** Lifecycle span `updatedAt - createdAt` in ms, or null (unparseable/negative). */
function resolutionMs(job: RelayJob): number | null {
  const created = Date.parse(job.createdAt);
  const updated = Date.parse(job.updatedAt);
  if (Number.isNaN(created) || Number.isNaN(updated)) return null;
  const span = updated - created;
  return span >= 0 ? span : null;
}

/**
 * Order two resolved jobs newest-first: most-recently-resolved (`updatedAt`)
 * comes first, then newest `createdAt`, then id — fully deterministic even when
 * two jobs share a resolution timestamp.
 */
function compareRecent(a: RelayJob, b: RelayJob): number {
  const ua = Date.parse(a.updatedAt);
  const ub = Date.parse(b.updatedAt);
  // Later updatedAt = more recent = should sort first.
  if (ua !== ub) return ub - ua;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the recent report: every terminal (`completed`/`failed`/`cancelled`)
 * job with a parseable `updatedAt`, ranked most-recently-resolved first. This
 * is the mirror image of `overdue` — instead of "what should have run but
 * hasn't", it's "what already ran and finished", the confirmation the relay is
 * doing its job.
 *
 * `withinMs` (positive) restricts to jobs resolved within that recent window;
 * `limit` (a positive integer) trims the returned `entries`, but
 * `totalTerminal`/`byOutcome` still reflect the full matched set so callers can
 * honestly report "N more not shown".
 */
export function buildRecentReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: RecentOptions = {}
): RecentReport {
  const withinMs =
    Number.isFinite(options.withinMs) && (options.withinMs as number) > 0 ? (options.withinMs as number) : null;

  const matched = jobs
    .filter((job) => {
      if (!TERMINAL_STATUSES.includes(job.status)) return false;
      const resolvedAt = Date.parse(job.updatedAt);
      if (Number.isNaN(resolvedAt)) return false;
      if (withinMs !== null && now - resolvedAt > withinMs) return false;
      return true;
    })
    .sort(compareRecent);

  const byOutcome: RecentOutcomeCounts = { completed: 0, failed: 0, cancelled: 0 };
  for (const job of matched) {
    byOutcome[job.status as keyof RecentOutcomeCounts] += 1;
  }

  const totalTerminal = matched.length;
  const { limit } = options;
  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? matched.slice(0, limit) : matched;

  const entries: RecentEntry[] = capped.map((job) => {
    const resolvedAt = Date.parse(job.updatedAt);
    return {
      job,
      resolvedAt,
      ageMs: Math.max(0, now - resolvedAt),
      resolutionMs: resolutionMs(job),
    };
  });

  return {
    entries,
    totalTerminal,
    hidden: totalTerminal - entries.length,
    byOutcome,
    withinMs,
  };
}

/** Exposed so `metrics`/tests can share the exact terminal-status set logic. */
export function isRecentTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
