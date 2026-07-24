// Structural diff between two snapshots of the JSON job store. The store file
// (`jobs.json`) is the single source of truth for a local-first relay, and
// `agentrelay backup` already takes point-in-time snapshots of it. What was
// missing is a way to answer "what has the relay actually *done* since that
// snapshot?" — which jobs did it pick up, resume, complete, fail, or prune —
// without eyeballing two raw JSON files.
//
// This module is pure (no filesystem, no clock): it takes two already-read job
// arrays and reports the delta. The `before`/`after` reads and snapshot
// resolution live in the CLI (`diffStore`), mirroring how backup/restore split
// pure selection from the actual I/O.

import type { RelayJob } from "./types.js";

/**
 * The job fields whose change between two snapshots counts as a meaningful
 * lifecycle delta. Deliberately excludes bookkeeping/large fields:
 * `updatedAt` moves whenever anything else does (so tracking it is redundant
 * and noisy) and `lastOutputTail` can be large and churns on every tick. A job
 * whose *only* difference is one of those excluded fields is reported as
 * unchanged — `diff` is about lifecycle transitions, not byte-equality.
 */
export type DiffableField = "status" | "resetAt" | "attempts" | "lastError" | "project" | "tool";

/** The tracked fields, in the order they're reported for a changed job. */
export const DIFFABLE_FIELDS: readonly DiffableField[] = [
  "status",
  "resetAt",
  "attempts",
  "lastError",
  "project",
  "tool",
];

/** A single field that differs between a job's before/after snapshot. */
export interface FieldChange {
  field: DiffableField;
  before: string | number | null;
  after: string | number | null;
}

/** A job present in both snapshots whose tracked fields changed. */
export interface JobChange {
  id: string;
  before: RelayJob;
  after: RelayJob;
  /** The differing fields, in {@link DIFFABLE_FIELDS} order (never empty). */
  changes: FieldChange[];
}

/** The delta between a `before` and an `after` snapshot of the store. */
export interface StoreDiff {
  /** Jobs present in `after` but not `before` (new since the snapshot). */
  added: RelayJob[];
  /** Jobs present in `before` but not `after` (gone — pruned/restored away). */
  removed: RelayJob[];
  /** Jobs in both snapshots whose tracked fields changed. */
  changed: JobChange[];
  /** Count of jobs present in both with no tracked change. */
  unchanged: number;
}

/**
 * Deterministic newest-first ordering, mirroring core `compareJobsNewestFirst`
 * (createdAt desc, id asc tiebreak). Inlined here so this pure module stays
 * free of the filesystem-touching queue module.
 */
function compareNewestFirst(a: RelayJob, b: RelayJob): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Index jobs by id; on duplicate ids the last wins, matching store semantics. */
function indexById(jobs: RelayJob[]): Map<string, RelayJob> {
  const map = new Map<string, RelayJob>();
  for (const job of jobs) map.set(job.id, job);
  return map;
}

function fieldValue(job: RelayJob, field: DiffableField): string | number | null {
  switch (field) {
    case "status":
      return job.status;
    case "resetAt":
      return job.resetAt;
    case "attempts":
      return job.attempts;
    case "lastError":
      return job.lastError;
    case "project":
      return job.project;
    case "tool":
      return job.tool;
  }
}

/** The tracked fields that differ between `before` and `after` (may be empty). */
function fieldChanges(before: RelayJob, after: RelayJob): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of DIFFABLE_FIELDS) {
    const b = fieldValue(before, field);
    const a = fieldValue(after, field);
    if (b !== a) out.push({ field, before: b, after: a });
  }
  return out;
}

/**
 * Computes the delta from `before` to `after`, matching jobs by id. A job only
 * in `after` is added; only in `before` is removed; in both with a tracked
 * change is changed; in both with no tracked change increments `unchanged`.
 * Added/removed jobs and the changed list are each ordered newest-first so the
 * output is stable regardless of input order. Pure: reads no I/O, mutates
 * neither input.
 */
export function diffJobs(before: RelayJob[], after: RelayJob[]): StoreDiff {
  const beforeById = indexById(before);
  const afterById = indexById(after);

  const added: RelayJob[] = [];
  const removed: RelayJob[] = [];
  const changed: JobChange[] = [];
  let unchanged = 0;

  for (const [id, afterJob] of afterById) {
    const beforeJob = beforeById.get(id);
    if (beforeJob === undefined) {
      added.push(afterJob);
      continue;
    }
    const changes = fieldChanges(beforeJob, afterJob);
    if (changes.length === 0) {
      unchanged += 1;
    } else {
      changed.push({ id, before: beforeJob, after: afterJob, changes });
    }
  }

  for (const [id, beforeJob] of beforeById) {
    if (!afterById.has(id)) removed.push(beforeJob);
  }

  added.sort(compareNewestFirst);
  removed.sort(compareNewestFirst);
  changed.sort((x, y) => compareNewestFirst(x.after, y.after));

  return { added, removed, changed, unchanged };
}

/** True when the two snapshots are identical across every tracked field. */
export function isEmptyDiff(diff: StoreDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}
