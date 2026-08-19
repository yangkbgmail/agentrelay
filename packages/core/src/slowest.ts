import type { JobStatus, RelayJob } from "./types.js";

/**
 * Statuses whose lifecycle span counts as a relay-driven resolution. Mirrors
 * the exact policy in `stats.ts`: only `completed`/`failed` jobs have a
 * meaningful "how long did the relay babysit this?" span. `cancelled` is a user
 * abort (not a relay resolution) and active jobs haven't finished, so both are
 * excluded — keeping `slowest` consistent with the `stats` resolution-time
 * aggregates it drills into.
 */
const RESOLVED_STATUSES = new Set<JobStatus>(["completed", "failed"]);

/** One resolved job and the wall-clock span the relay spent resolving it. */
export interface SlowestEntry {
  /** The terminal (completed/failed) job this row describes. */
  job: RelayJob;
  /** Lifecycle span `updatedAt - createdAt` in ms (always ≥ 0). */
  resolutionMs: number;
}

/**
 * The individual worst-resolution jobs behind the `stats` resolution-time
 * aggregates. `stats` reports the *distribution* (avg/median/p90/p95/p99); this
 * report names the *specific* jobs that dragged the tail — the ones the relay
 * spent longest getting through their rate-limit windows. Answers "which task
 * took the most babysitting?" rather than "how bad does it get on average?".
 */
export interface SlowestReport {
  /** Resolved jobs, slowest-first, trimmed to `limit` when one was given. */
  entries: SlowestEntry[];
  /** Total resolved jobs with a parseable span, before any `limit` trim. */
  totalResolved: number;
  /** How many resolved jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The single worst resolution span in ms (0 when nothing resolved). */
  maxResolutionMs: number;
  /** Sum of every resolved span in ms, before the trim (0 when none). */
  totalResolutionMs: number;
}

/** Options for {@link buildSlowestReport}. */
export interface SlowestOptions {
  /** Show at most this many entries; the totals still count them all. */
  limit?: number;
}

/**
 * Lifecycle span of a job in ms (`updatedAt - createdAt`), or null when either
 * timestamp is missing/unparseable or the span is negative (clock skew). Same
 * rule as `stats.ts` so both surfaces agree on which spans are counted and how.
 */
function resolutionMs(job: RelayJob): number | null {
  const created = Date.parse(job.createdAt);
  const updated = Date.parse(job.updatedAt);
  if (Number.isNaN(created) || Number.isNaN(updated)) return null;
  const span = updated - created;
  return span >= 0 ? span : null;
}

/**
 * Order two resolved jobs slowest-first: longer span comes first, then oldest
 * `createdAt`, then id — fully deterministic even when two jobs share an
 * identical span. The tie-break keeps the ranking stable across runs so a
 * `--limit` cut is reproducible.
 */
function compareSlowest(a: SlowestEntry, b: SlowestEntry): number {
  if (a.resolutionMs !== b.resolutionMs) return b.resolutionMs - a.resolutionMs;
  if (a.job.createdAt !== b.job.createdAt) return a.job.createdAt < b.job.createdAt ? -1 : 1;
  if (a.job.id === b.job.id) return 0;
  return a.job.id < b.job.id ? -1 : 1;
}

/**
 * Build the slowest-resolution report: every terminal job with a parseable,
 * non-negative lifecycle span, ranked longest-span first. Pure — no clock, no
 * I/O — so it is unit-testable end to end and the caller decides which job set
 * (whole store, or a scoped subset) to feed in.
 *
 * `limit` (a non-negative integer) trims the returned `entries`, but
 * `totalResolved`/`maxResolutionMs`/`totalResolutionMs` still reflect the full
 * set so callers can honestly report "N more not shown".
 */
export function buildSlowestReport(jobs: RelayJob[], options: SlowestOptions = {}): SlowestReport {
  const resolved: SlowestEntry[] = [];
  let totalResolutionMs = 0;
  for (const job of jobs) {
    if (!RESOLVED_STATUSES.has(job.status)) continue;
    const ms = resolutionMs(job);
    if (ms === null) continue;
    resolved.push({ job, resolutionMs: ms });
    totalResolutionMs += ms;
  }
  resolved.sort(compareSlowest);

  const totalResolved = resolved.length;
  const { limit } = options;
  const capped =
    typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? resolved.slice(0, limit) : resolved;

  return {
    entries: capped,
    totalResolved,
    hidden: totalResolved - capped.length,
    maxResolutionMs: totalResolved > 0 ? resolved[0].resolutionMs : 0,
    totalResolutionMs,
  };
}
