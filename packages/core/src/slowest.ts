import { jobResolutionMs, RESOLVED_STATUSES } from "./stats.js";
import type { RelayJob } from "./types.js";

/**
 * One resolved job in the slowest-first ranking, carrying its lifecycle span so
 * the CLI can render "this job took N" rows. Computed purely from the job list —
 * no clock, no queue, no I/O — so `agentrelay slowest` is unit-testable end to end.
 */
export interface SlowestEntry {
  /** The resolved (completed/failed) job this row describes. */
  job: RelayJob;
  /** Lifecycle span in ms (`updatedAt - createdAt`): how long the relay looked after it. */
  resolutionMs: number;
  /** 1-based rank in slowest-first order (1 = took longest). */
  rank: number;
}

/**
 * The tail-latency view: which specific jobs cost the relay the most wall-clock
 * time between being queued and reaching a terminal state. Where `stats` reports
 * aggregate resolution percentiles (avg/median/p90), `slowest` names the actual
 * outlier jobs behind that tail so you can open them with `agentrelay show`.
 */
export interface SlowestReport {
  /** Rows, longest-resolution first. Trimmed to `limit` when one was given. */
  entries: SlowestEntry[];
  /** How many jobs have a countable resolution span in total (before any `limit` trim). */
  totalResolved: number;
  /** How many resolved jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
}

/**
 * Order two resolved jobs slowest-first: longer span wins, then more recently
 * updated (a fresh slow job is more interesting than an old one), then id — so
 * the ordering is fully deterministic even when two jobs share a span.
 */
function compareSlowest(a: SlowestEntry, b: SlowestEntry): number {
  if (a.resolutionMs !== b.resolutionMs) return b.resolutionMs - a.resolutionMs;
  const ua = Date.parse(a.job.updatedAt);
  const ub = Date.parse(b.job.updatedAt);
  if (ua !== ub) return ub - ua;
  if (a.job.id === b.job.id) return 0;
  return a.job.id < b.job.id ? -1 : 1;
}

/**
 * Rank the resolved jobs by how long they took to resolve, slowest first. Only
 * jobs whose status is in {@link RESOLVED_STATUSES} and that have a valid,
 * non-negative lifecycle span (via {@link jobResolutionMs}) are ranked — the
 * exact set `computeStats`'s timing metrics summarize, so the two never drift.
 *
 * `limit` (when a positive integer) trims the returned `entries` to the slowest
 * N, but `totalResolved` still reflects the full set so callers can honestly
 * report "N more not shown".
 */
export function computeSlowest(jobs: RelayJob[], limit?: number): SlowestReport {
  const ranked = jobs
    .filter((job) => RESOLVED_STATUSES.includes(job.status))
    .map((job) => ({ job, resolutionMs: jobResolutionMs(job) }))
    .filter((r): r is { job: RelayJob; resolutionMs: number } => r.resolutionMs !== null)
    .map((r) => ({ job: r.job, resolutionMs: r.resolutionMs, rank: 0 }))
    .sort(compareSlowest);

  const totalResolved = ranked.length;
  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? ranked.slice(0, limit) : ranked;

  const entries: SlowestEntry[] = capped.map((entry, index) => ({ ...entry, rank: index + 1 }));

  return {
    entries,
    totalResolved,
    hidden: totalResolved - entries.length,
  };
}
