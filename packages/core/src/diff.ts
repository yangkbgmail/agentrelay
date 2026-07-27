// Comparing two snapshots of the JSON store. The store file (`jobs.json`) is the
// single source of truth for a local-first relay, and the surrounding ecosystem
// already lets you snapshot it (`backup`), roll it back (`restore`), and move it
// between machines (`export`/`import`). What was missing is the natural question
// that follows any of those operations: *what actually changed between two
// states of the store?* After a restore, an import, or a stretch of the daemon
// running unattended, `diff` answers "which jobs appeared, which disappeared, and
// which changed status/reset/attempts" in one glance.
//
// This module is pure: it compares two already-loaded job arrays and reports the
// delta. The filesystem read of the snapshot lives in the CLI (commands.ts),
// mirroring how backup/restore keep their pure helpers here and their I/O there.

import type { RelayJob } from "./types.js";

/**
 * The job fields `diff` inspects for a "changed" job. Deliberately a curated set
 * of *meaningful lifecycle* fields rather than every field: `updatedAt` bumps on
 * any touch (so it would flag almost every job as changed and drown out the real
 * signal), and `command`/`cwd`/`project`/`tool` are set once at enqueue and
 * effectively immutable. What's left is the state that genuinely moves over a
 * job's life — its status, the reset it's waiting on, how many attempts it has
 * taken, and its last error.
 */
export const DIFF_FIELDS = ["status", "resetAt", "attempts", "lastError"] as const;

/** One of the fields {@link DIFF_FIELDS} compares. */
export type DiffField = (typeof DIFF_FIELDS)[number];

/** A single field that differs between the before/after versions of a job. */
export interface JobFieldChange {
  /** Which field changed. */
  field: DiffField;
  /** The value in the "before" store, rendered as a display string. */
  before: string;
  /** The value in the "after" store, rendered as a display string. */
  after: string;
}

/** A job present in both stores whose tracked fields differ. */
export interface JobChange {
  /** The job id (stable across both stores). */
  id: string;
  /** The job's project label (taken from the "after" version). */
  project: string;
  /** The fields that differ, in {@link DIFF_FIELDS} order. */
  changes: JobFieldChange[];
}

/** The delta between two job stores (see {@link diffJobStores}). */
export interface StoreDiff {
  /** Jobs whose id is in "after" but not "before" — they appeared. */
  added: RelayJob[];
  /** Jobs whose id is in "before" but not "after" — they disappeared (e.g. pruned). */
  removed: RelayJob[];
  /** Jobs present in both whose tracked fields differ (see {@link DIFF_FIELDS}). */
  changed: JobChange[];
  /** Count of jobs present in both with no tracked field difference. */
  unchangedCount: number;
  /** Total jobs in the "before" store. */
  beforeCount: number;
  /** Total jobs in the "after" store. */
  afterCount: number;
}

/**
 * Render a tracked field's value as a stable display string. `null`/`undefined`
 * become `(none)` so an absent reset or error reads clearly rather than as an
 * empty cell, and numbers are stringified so `attempts` compares by value.
 */
function fieldValue(job: RelayJob, field: DiffField): string {
  const raw = job[field];
  if (raw === null || raw === undefined) return "(none)";
  return String(raw);
}

/**
 * Compare two loaded job stores (`before` → `after`) and report the delta:
 * jobs added, removed, and changed, plus the count that stayed identical. Jobs
 * are matched by `id`; only the curated {@link DIFF_FIELDS} decide "changed".
 *
 * Pure and order-independent: the store arrays may be in any order (last write
 * wins on duplicate ids, which real stores never have). `added`/`removed`
 * preserve first-seen order from their source array; `changed` follows `after`
 * order so the report reads like the current store.
 */
export function diffJobStores(before: RelayJob[], after: RelayJob[]): StoreDiff {
  const beforeById = new Map<string, RelayJob>();
  for (const job of before) beforeById.set(job.id, job);
  const afterById = new Map<string, RelayJob>();
  for (const job of after) afterById.set(job.id, job);

  const removed: RelayJob[] = [];
  for (const job of before) {
    if (!afterById.has(job.id)) removed.push(job);
  }

  const added: RelayJob[] = [];
  const changed: JobChange[] = [];
  let unchangedCount = 0;
  for (const job of after) {
    const prior = beforeById.get(job.id);
    if (!prior) {
      added.push(job);
      continue;
    }
    const changes: JobFieldChange[] = [];
    for (const field of DIFF_FIELDS) {
      const b = fieldValue(prior, field);
      const a = fieldValue(job, field);
      if (b !== a) changes.push({ field, before: b, after: a });
    }
    if (changes.length > 0) {
      changed.push({ id: job.id, project: job.project, changes });
    } else {
      unchangedCount += 1;
    }
  }

  return {
    added,
    removed,
    changed,
    unchangedCount,
    beforeCount: before.length,
    afterCount: after.length,
  };
}

/** Whether a {@link StoreDiff} reports no additions, removals, or changes. */
export function isStoreDiffEmpty(diff: StoreDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}
