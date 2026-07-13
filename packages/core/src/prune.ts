import type { JobStatus, RelayJob } from "./types.js";

/**
 * Finished jobs that are safe to remove by default. Active states
 * (`queued`, `waiting_for_reset`, `resuming`) represent pending work and are
 * never pruned unless a caller explicitly asks for them.
 */
export const DEFAULT_PRUNABLE_STATUSES: JobStatus[] = ["completed", "failed"];

export interface PruneOptions {
  /**
   * Only jobs in these statuses are eligible for pruning. Defaults to the
   * terminal states (`completed`, `failed`). Passing active statuses lets a
   * caller force-clear a stuck queue, but that's opt-in.
   */
  statuses?: JobStatus[];
  /**
   * Only prune jobs that haven't been touched (`updatedAt`) for at least this
   * many milliseconds before {@link now}. `0`/`undefined` disables the age
   * filter (every status-eligible job is a candidate).
   */
  olderThanMs?: number;
  /**
   * Always retain the N most-recently-updated eligible jobs, regardless of
   * age. Useful for keeping a short history while still bounding the store.
   */
  keepLast?: number;
  /** Reference "now" for the age comparison. Defaults to the current time. */
  now?: Date;
}

export interface PruneSelection {
  /** Jobs that match the prune criteria and would be removed. */
  prune: RelayJob[];
  /** Jobs that survive (everything not in {@link prune}). */
  keep: RelayJob[];
}

function updatedAtMs(job: RelayJob): number {
  const t = new Date(job.updatedAt).getTime();
  // A job with an unparseable timestamp sorts as "oldest" so it can be swept.
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Pure, side-effect-free partition of `jobs` into the ones a prune would delete
 * and the ones it would keep, applying the status / age / keep-last rules. The
 * queue layer uses this so the selection logic stays testable without touching
 * the filesystem.
 */
export function selectPrunableJobs(jobs: RelayJob[], options: PruneOptions = {}): PruneSelection {
  const statuses = options.statuses ?? DEFAULT_PRUNABLE_STATUSES;
  const now = (options.now ?? new Date()).getTime();
  const cutoff = options.olderThanMs && options.olderThanMs > 0 ? now - options.olderThanMs : null;

  const statusEligible = jobs.filter((job) => statuses.includes(job.status));

  // Newest first, so keepLast protects the most recent survivors.
  const byRecency = [...statusEligible].sort((a, b) => updatedAtMs(b) - updatedAtMs(a));
  const protectedIds =
    options.keepLast && options.keepLast > 0
      ? new Set(byRecency.slice(0, options.keepLast).map((job) => job.id))
      : new Set<string>();

  const prune = statusEligible.filter((job) => {
    if (protectedIds.has(job.id)) return false;
    if (cutoff !== null && updatedAtMs(job) > cutoff) return false; // too recent
    return true;
  });

  const pruneIds = new Set(prune.map((job) => job.id));
  const keep = jobs.filter((job) => !pruneIds.has(job.id));
  return { prune, keep };
}

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parses a human duration like `7d`, `24h`, `30m`, `90s`, `500ms` into
 * milliseconds. Returns `null` for anything it doesn't understand (empty
 * string, missing/unknown unit, negative) so callers can report a clear error
 * instead of silently pruning with a garbage threshold.
 */
export function parseDuration(input: string): number | null {
  const match = DURATION_RE.exec(input.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  return value * UNIT_MS[match[2].toLowerCase()];
}
