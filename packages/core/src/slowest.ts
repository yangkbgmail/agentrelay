import { RESOLVED_STATUSES, resolutionMs } from "./stats.js";
import type { RelayJob } from "./types.js";

/**
 * One resolved job together with how long the relay babysat it end to end —
 * its lifecycle span `updatedAt - createdAt`. Computed purely from the job
 * list (no clock, no queue, no I/O) so `agentrelay slowest` is unit-testable.
 */
export interface SlowestEntry {
  /** The resolved job this row describes. */
  job: RelayJob;
  /** Lifecycle span in ms (`updatedAt - createdAt`, always ≥ 0). */
  resolutionMs: number;
}

/**
 * The jobs the relay had to babysit the longest, ranked slowest-first. Where
 * `stats` reports the aggregate resolution percentiles (p50/p90/max), this
 * names the concrete jobs behind that tail — the ones that sat, cycling
 * rate-limits and retries, from queue to a terminal state for the longest.
 * "Resolved" matches `stats`: completed + failed only (a cancelled job is a
 * user cut, not a relay-driven resolution), and a job needs a valid,
 * non-negative span to count.
 */
export interface SlowestReport {
  /** Rows slowest-first. Trimmed to `limit` when one was given. */
  entries: SlowestEntry[];
  /** Total resolved jobs with a valid span, before any `limit` trim. */
  totalResolved: number;
  /** How many resolved jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The single longest resolution span in ms (0 when nothing resolved). */
  maxResolutionMs: number;
}

/** Options for {@link buildSlowestReport}. */
export interface SlowestOptions {
  /** Show at most this many entries; totals still count them all. */
  limit?: number;
}

/**
 * Order two resolved jobs slowest-first: the longer lifecycle span comes first,
 * ties broken by newer `updatedAt` (most recently resolved first), then id — so
 * the ranking is fully deterministic even when two jobs took exactly as long.
 */
function compareSlowest(a: SlowestEntry, b: SlowestEntry): number {
  if (a.resolutionMs !== b.resolutionMs) return b.resolutionMs - a.resolutionMs;
  if (a.job.updatedAt !== b.job.updatedAt) return a.job.updatedAt < b.job.updatedAt ? 1 : -1;
  if (a.job.id === b.job.id) return 0;
  return a.job.id < b.job.id ? -1 : 1;
}

/**
 * Build the slowest-jobs report: every resolved job (completed + failed) with a
 * valid, non-negative lifecycle span, ranked longest-first.
 *
 * `limit` (a positive integer) trims the returned `entries`, but
 * `totalResolved`/`maxResolutionMs` still reflect the full set so callers can
 * honestly report "N more not shown". Pure and non-mutating.
 */
export function buildSlowestReport(jobs: RelayJob[], options: SlowestOptions = {}): SlowestReport {
  const entries: SlowestEntry[] = [];
  for (const job of jobs) {
    if (!RESOLVED_STATUSES.includes(job.status)) continue;
    const span = resolutionMs(job);
    if (span === null) continue;
    entries.push({ job, resolutionMs: span });
  }
  entries.sort(compareSlowest);

  const totalResolved = entries.length;
  const { limit } = options;
  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? entries.slice(0, limit) : entries;

  return {
    entries: capped,
    totalResolved,
    hidden: totalResolved - capped.length,
    maxResolutionMs: totalResolved > 0 ? entries[0].resolutionMs : 0,
  };
}
