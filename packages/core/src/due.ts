/**
 * Fair ordering for the resume queue.
 *
 * `listDue` collects every job whose rate-limit reset time has passed, but the
 * order it returns them in matters as soon as the resume loop is *bounded*: with
 * `AGENTRELAY_MAX_CONCURRENT` set (or the default serial loop), only so many
 * jobs resume at once, so whichever job sits at the front of the list goes
 * first. Historically that front-of-list position was just JSON/Map insertion
 * order — effectively "whoever was enqueued first", which has nothing to do with
 * who has been *waiting* the longest.
 *
 * When a "resume herd" forms (many jobs share one reset window, or a daemon was
 * asleep and several windows reopened while it was down), the fair thing is to
 * drain the most-overdue job first: the one whose window reopened earliest has
 * already waited the longest, so it should not sit behind a job that only just
 * became due. {@link orderDueJobs} makes that ordering explicit and
 * deterministic instead of leaving it to store insertion order.
 *
 * Ordering (ascending, so the front of the list resumes first):
 *   1. `resetAt` — earliest reset (most overdue) first. A `null` resetAt sorts
 *      last; a due job normally has a concrete resetAt, but guarding keeps the
 *      function total for any job list callers hand it.
 *   2. `createdAt` — older job first, breaking ties between jobs that share a
 *      reset time (a common case: a whole project's jobs park on one window).
 *   3. original order — the sort is stable, so jobs equal on both keys keep the
 *      order they came in (no reliance on random ids for a deterministic result).
 *
 * Pure and non-mutating: returns a new array and never touches the store, so it
 * is trivially unit-testable and safe to reuse anywhere a fair drain order is
 * wanted (e.g. a future `tick --dry-run` preview).
 */

import type { RelayJob } from "./types.js";

/** Epoch ms for a job's reset time; `null`/unparseable sorts to the very end. */
function resetMs(job: RelayJob): number {
  if (job.resetAt === null) return Number.POSITIVE_INFINITY;
  const t = new Date(job.resetAt).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/** Epoch ms for a job's creation time; unparseable sorts to the end. */
function createdMs(job: RelayJob): number {
  const t = new Date(job.createdAt).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Return a new array of `jobs` ordered so the most-overdue job (earliest
 * `resetAt`) resumes first, ties broken by creation time then by original
 * order. Does not mutate the input.
 */
export function orderDueJobs(jobs: readonly RelayJob[]): RelayJob[] {
  return [...jobs].sort((a, b) => {
    const byReset = resetMs(a) - resetMs(b);
    if (byReset !== 0) return byReset;
    return createdMs(a) - createdMs(b);
  });
}
