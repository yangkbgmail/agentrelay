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

/**
 * Age threshold used by auto-prune when the daemon opts in without giving an
 * explicit `AGENTRELAY_AUTOPRUNE_AFTER`. One week keeps a useful window of
 * finished-job history while still bounding the store.
 */
export const DEFAULT_AUTOPRUNE_AFTER_MS = 7 * UNIT_MS.d;

function parseBool(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Builds the {@link PruneOptions} the scheduler should apply after each tick,
 * from environment variables — or `null` when auto-prune is off (the default).
 * Lets a long-running daemon keep the JSON store bounded without a separate
 * `agentrelay prune` cron:
 *
 * - `AGENTRELAY_AUTOPRUNE`        opt-in flag (1/true/yes/on). Off ⇒ returns null.
 * - `AGENTRELAY_AUTOPRUNE_AFTER`  age threshold like `7d`/`24h` (default 7d).
 *                                 `0s` prunes every finished job regardless of age.
 *                                 An unparseable value falls back to the 7d default
 *                                 rather than disabling the opt-in.
 * - `AGENTRELAY_AUTOPRUNE_KEEP`   always retain the N most-recent finished jobs.
 *
 * Only terminal states (`completed`/`failed`) are ever swept — active jobs are
 * left untouched, matching the manual `prune` command's safe default.
 */
export function autoPruneOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): PruneOptions | null {
  if (!parseBool(env.AGENTRELAY_AUTOPRUNE)) return null;

  let olderThanMs = DEFAULT_AUTOPRUNE_AFTER_MS;
  const afterRaw = env.AGENTRELAY_AUTOPRUNE_AFTER?.trim();
  if (afterRaw) {
    const parsed = parseDuration(afterRaw);
    if (parsed !== null) olderThanMs = parsed;
  }

  let keepLast: number | undefined;
  const keepRaw = env.AGENTRELAY_AUTOPRUNE_KEEP?.trim();
  if (keepRaw) {
    const n = Number(keepRaw);
    if (Number.isFinite(n) && n >= 0) keepLast = Math.floor(n);
  }

  return { olderThanMs, keepLast };
}
