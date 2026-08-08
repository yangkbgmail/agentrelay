// Compares two sets of jobs — the pure engine behind `agentrelay diff`, which
// answers "what changed in the store since this snapshot?". It is the read-only
// companion to the backup/restore family: `restore --dry-run` (queue.ts) reports
// *counts* of what a restore would replace, but not *which* jobs would appear,
// vanish, or change. This module fills that gap and, being pure (no filesystem,
// no clock), is trivially testable; the CLI (`commands.ts`) reads the snapshot
// and the live store, then hands both arrays here.

import { compareJobsNewestFirst } from "./queue.js";
import type { RelayJob } from "./types.js";

/** A single tracked field whose value differs between two versions of a job. */
export interface JobFieldChange {
  /** The job field that changed (one of {@link DIFF_TRACKED_FIELDS}). */
  field: DiffTrackedField;
  /** Its value in the base (older) version. */
  before: unknown;
  /** Its value in the target (newer) version. */
  after: unknown;
}

/** A job present in both sides whose tracked fields differ. */
export interface ChangedJob {
  /** The job id (identical on both sides). */
  id: string;
  /** The base (older) version of the job. */
  before: RelayJob;
  /** The target (newer) version of the job. */
  after: RelayJob;
  /** The tracked fields that differ, in {@link DIFF_TRACKED_FIELDS} order. */
  changes: JobFieldChange[];
}

/** The full comparison of two job sets (base → target). */
export interface JobsDiff {
  /** Jobs present in the target but not the base (newly appeared). */
  added: RelayJob[];
  /** Jobs present in the base but not the target (gone). */
  removed: RelayJob[];
  /** Jobs present in both whose tracked fields differ. */
  changed: ChangedJob[];
  /** How many jobs are present in both with no tracked-field difference. */
  unchanged: number;
}

/**
 * The mutable, meaningful-to-surface fields a job accrues over its lifecycle.
 * Identity/enqueue-time fields (`id`, `createdAt`, `project`, `tool`, `command`,
 * `cwd`) are deliberately excluded: `id` keys the comparison, and the rest are
 * fixed at enqueue and never drift, so listing them as "changes" would be noise.
 * `lastRateLimit` is an object (structural compare, rare to hand-diff) and is
 * left out for the same "surface the signal" reason.
 */
export const DIFF_TRACKED_FIELDS = [
  "status",
  "attempts",
  "resetAt",
  "updatedAt",
  "lastError",
  "lastOutputTail",
] as const;

export type DiffTrackedField = (typeof DIFF_TRACKED_FIELDS)[number];

/**
 * Diffs two job sets, describing how to get from `base` to `target`:
 *   - `added`   — in `target`, not in `base`
 *   - `removed` — in `base`, not in `target`
 *   - `changed` — in both, with at least one differing tracked field
 *   - `unchanged` — in both, all tracked fields equal (count only)
 *
 * Jobs are matched by `id`. When a set contains duplicate ids (it shouldn't —
 * the store keys by id — but a hand-edited snapshot might), the last occurrence
 * wins, matching the store's own load semantics. `fields` lets callers narrow
 * the tracked set (defaults to {@link DIFF_TRACKED_FIELDS}). Ordering is
 * deterministic: `added`/`removed`/`changed` are sorted newest-first (by
 * `createdAt`, id tiebreak) exactly like the store's listings, so the diff reads
 * in the same order as `agentrelay status`.
 */
export function diffJobs(
  base: RelayJob[],
  target: RelayJob[],
  fields: readonly DiffTrackedField[] = DIFF_TRACKED_FIELDS
): JobsDiff {
  const baseById = new Map<string, RelayJob>();
  for (const job of base) baseById.set(job.id, job);
  const targetById = new Map<string, RelayJob>();
  for (const job of target) targetById.set(job.id, job);

  const added: RelayJob[] = [];
  const removed: RelayJob[] = [];
  const changed: ChangedJob[] = [];
  let unchanged = 0;

  for (const [id, targetJob] of targetById) {
    const baseJob = baseById.get(id);
    if (!baseJob) {
      added.push(targetJob);
      continue;
    }
    const changes = fieldChanges(baseJob, targetJob, fields);
    if (changes.length > 0) {
      changed.push({ id, before: baseJob, after: targetJob, changes });
    } else {
      unchanged++;
    }
  }

  for (const [id, baseJob] of baseById) {
    if (!targetById.has(id)) removed.push(baseJob);
  }

  added.sort(compareJobsNewestFirst);
  removed.sort(compareJobsNewestFirst);
  changed.sort((a, b) => compareJobsNewestFirst(a.after, b.after));

  return { added, removed, changed, unchanged };
}

/** The tracked fields that differ between two versions of the same job. */
function fieldChanges(before: RelayJob, after: RelayJob, fields: readonly DiffTrackedField[]): JobFieldChange[] {
  const changes: JobFieldChange[] = [];
  for (const field of fields) {
    const b = before[field];
    const a = after[field];
    if (b !== a) changes.push({ field, before: b, after: a });
  }
  return changes;
}

/** True when a diff records no additions, removals, or changes. */
export function isEmptyDiff(diff: JobsDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}
