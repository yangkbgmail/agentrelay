// Pure helpers for job resume *priority* — kept separate from the mutating
// queue (like `parser`/`control`/`summary`) so ordering logic is unit-testable
// without a store, a clock, or a spawned process.
//
// Why priority exists: when a rate-limit window reopens, several jobs can come
// due in the same scheduler tick (a "resume herd" sharing one reset time).
// Until now they resumed in arbitrary store order. Priority lets a user say
// "resume *this* job first" (`agentrelay run --priority 10 -- …`) so the
// important task catches the freshly-reset window before the rest.

import type { RelayJob } from "./types.js";

/** The priority a job has when the user didn't set one. */
export const DEFAULT_PRIORITY = 0;

/**
 * A job's effective priority, tolerant of legacy stores (field absent) and
 * corrupt values (non-number / NaN / Infinity). Any of those collapse to
 * {@link DEFAULT_PRIORITY} so a bad value can never reorder the queue in a
 * surprising way — it just sorts as a normal default-priority job.
 */
export function jobPriority(job: Pick<RelayJob, "priority">): number {
  const p = job.priority;
  return typeof p === "number" && Number.isFinite(p) ? p : DEFAULT_PRIORITY;
}

/**
 * Normalize a user-supplied priority to a finite integer. Non-finite / nullish
 * inputs fall back to {@link DEFAULT_PRIORITY}; fractional values are truncated
 * toward zero (so `--priority 2.9` means 2, not a silent reject). Negative
 * values are allowed — they deprioritize a job below the default.
 */
export function normalizePriority(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return DEFAULT_PRIORITY;
  return Math.trunc(value);
}

/**
 * Compare two jobs for resume order: **higher priority first**, then a stable,
 * deterministic tie-break so a batch of equal-priority jobs always resumes in
 * the same order regardless of the engine's sort internals:
 *   1. priority — descending (10 before 0 before −5)
 *   2. resetAt — ascending (the window that opened earliest goes first; fair to
 *      the job that has been waiting longest). Null / unparseable sorts last.
 *   3. createdAt — ascending (FIFO among jobs enqueued for the same window)
 *   4. id — lexicographic, the final determinism guarantee
 */
export function compareByPriority(a: RelayJob, b: RelayJob): number {
  const pa = jobPriority(a);
  const pb = jobPriority(b);
  if (pa !== pb) return pb - pa;

  const ra = parseTimeOrInf(a.resetAt);
  const rb = parseTimeOrInf(b.resetAt);
  if (ra !== rb) return ra - rb;

  const ca = parseTimeOrInf(a.createdAt);
  const cb = parseTimeOrInf(b.createdAt);
  if (ca !== cb) return ca - cb;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Parse an ISO timestamp to epoch ms, mapping null/invalid to +Infinity (sorts last). */
function parseTimeOrInf(value: string | null): number {
  if (value === null) return Number.POSITIVE_INFINITY;
  const t = Date.parse(value);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/** Return a new array of `jobs` sorted by {@link compareByPriority}. Non-mutating. */
export function sortByPriority(jobs: RelayJob[]): RelayJob[] {
  return [...jobs].sort(compareByPriority);
}
