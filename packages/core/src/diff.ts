// Comparing two point-in-time snapshots of the JSON store. `backup`/`restore`
// give you rotating snapshots and the daemon can auto-back-up; the natural
// companion is a way to ask "what changed between two of these snapshots — or
// between a snapshot and the queue right now?". That answers the after-you-were
// -away question directly: which jobs resumed, which failed, which are new, and
// which had their status/attempts/reset moved — without eyeballing two `status`
// dumps side by side.
//
// This module is pure: it takes two already-read job arrays and diffs them by
// id. The filesystem reads (resolving a snapshot selector, parsing the file)
// live in the CLI wrapper so the comparison itself stays trivially testable.

import type { RelayJob } from "./types.js";

/** A single tracked field whose value differs between the two snapshots of a job. */
export interface JobFieldChange {
  /** Field name, e.g. `status`, `attempts`, `resetAt`. */
  field: string;
  /** Value in the "before" snapshot (null when unset, e.g. a cleared error). */
  before: string | number | null;
  /** Value in the "after" snapshot. */
  after: string | number | null;
}

/** A job present in both snapshots whose tracked fields changed. */
export interface JobChange {
  id: string;
  /** The job as it was in the "before" snapshot. */
  before: RelayJob;
  /** The job as it is in the "after" snapshot. */
  after: RelayJob;
  /** The fields that differ, in {@link DIFF_TRACKED_FIELDS} order. */
  fields: JobFieldChange[];
}

/** The difference between two job-store snapshots, keyed by job id. */
export interface JobDiff {
  /** Jobs present only in "after" (newly enqueued since "before"). */
  added: RelayJob[];
  /** Jobs present only in "before" (removed/pruned since "before"). */
  removed: RelayJob[];
  /** Jobs present in both with at least one tracked field changed. */
  changed: JobChange[];
  /** Count of jobs present in both with no tracked field changed. */
  unchanged: number;
}

interface FieldSpec {
  field: string;
  get: (job: RelayJob) => string | number | null;
}

/**
 * The lifecycle fields a diff reports on. Deliberately excludes noisy or
 * immutable ones: `updatedAt` bumps on every touch, `createdAt` never changes,
 * and `lastOutputTail`/`lastRateLimit` are large blobs that would drown the
 * signal. What's left is what a person actually asks "did this change?" about.
 */
const TRACKED_FIELDS: readonly FieldSpec[] = [
  { field: "status", get: (j) => j.status },
  { field: "attempts", get: (j) => j.attempts },
  { field: "resetAt", get: (j) => j.resetAt },
  { field: "project", get: (j) => j.project },
  { field: "tool", get: (j) => j.tool },
  { field: "command", get: (j) => j.command.join(" ") },
  { field: "lastError", get: (j) => j.lastError },
];

/** The field names compared by {@link diffJobs}, in report order. */
export const DIFF_TRACKED_FIELDS: readonly string[] = TRACKED_FIELDS.map((f) => f.field);

/**
 * Newest-first ordering (createdAt desc, id asc as a stable tiebreak), matching
 * the store's own list convention so diff groups read in the same order as
 * `status`. Local to this module so diff.ts stays standalone.
 */
function compareJobs(a: RelayJob, b: RelayJob): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function diffFields(before: RelayJob, after: RelayJob): JobFieldChange[] {
  const out: JobFieldChange[] = [];
  for (const spec of TRACKED_FIELDS) {
    const b = spec.get(before);
    const a = spec.get(after);
    if (b !== a) out.push({ field: spec.field, before: b, after: a });
  }
  return out;
}

/**
 * Diff two job arrays by id: which jobs are new in `after`, which are gone from
 * `after`, and which changed a tracked field (see {@link TRACKED_FIELDS}). Jobs
 * present in both with no tracked change are counted in `unchanged`. Each group
 * is sorted newest-first; the inputs are never mutated. Pure: no clock, no I/O.
 */
export function diffJobs(before: RelayJob[], after: RelayJob[]): JobDiff {
  const beforeById = new Map(before.map((j) => [j.id, j] as const));
  const afterById = new Map(after.map((j) => [j.id, j] as const));

  const added: RelayJob[] = [];
  const removed: RelayJob[] = [];
  const changed: JobChange[] = [];
  let unchanged = 0;

  for (const job of afterById.values()) {
    if (!beforeById.has(job.id)) added.push(job);
  }
  for (const job of beforeById.values()) {
    const now = afterById.get(job.id);
    if (!now) {
      removed.push(job);
      continue;
    }
    const fields = diffFields(job, now);
    if (fields.length > 0) changed.push({ id: job.id, before: job, after: now, fields });
    else unchanged += 1;
  }

  added.sort(compareJobs);
  removed.sort(compareJobs);
  changed.sort((a, b) => compareJobs(a.before, b.before));

  return { added, removed, changed, unchanged };
}

/** True when the two snapshots are identical across every tracked dimension. */
export function isEmptyDiff(diff: JobDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}
