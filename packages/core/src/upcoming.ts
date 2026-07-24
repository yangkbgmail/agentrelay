import type { RelayJob } from "./types.js";

/**
 * One entry in the forward-looking resume timeline: a job the relay is waiting
 * to resume, plus how long until it comes due. Where `next` (see next.ts)
 * surfaces the single most imminent resume and `status` snapshots the whole
 * queue regardless of state, `upcoming` answers "what's resuming, in order,
 * over the next stretch?" — the schedule of the relay's future moves.
 */
export interface UpcomingResume {
  /** A `waiting_for_reset` job with a parseable `resetAt`. */
  job: RelayJob;
  /** Milliseconds from `now` until its reset; zero/negative once it has passed. */
  dueInMs: number;
  /** True once the reset time has passed — a scheduler tick would pick it up now. */
  due: boolean;
}

/** Options for {@link selectUpcoming}. All optional; each narrows the result. */
export interface UpcomingOptions {
  /** Reference time (epoch ms) for the countdown. Defaults to `Date.now()`. */
  now?: number;
  /**
   * Only include jobs due within this many ms from `now` (upper bound on
   * `dueInMs`). Already-due jobs (`dueInMs <= 0`) always qualify since they
   * sit at or below any non-negative window. `null`/`undefined` = no window.
   */
  withinMs?: number | null;
  /** Keep only the first N entries after sorting. `null`/`undefined` = all. */
  limit?: number | null;
}

/**
 * Order two waiting jobs by which the scheduler will resume first: earliest
 * reset time wins, then oldest `createdAt`, then id — identical to `next`'s
 * ordering so the head of `upcoming` is exactly what `next` reports.
 */
function compareUpcoming(a: RelayJob, b: RelayJob): number {
  const ra = Date.parse(a.resetAt as string);
  const rb = Date.parse(b.resetAt as string);
  if (ra !== rb) return ra - rb;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the resume timeline: every `waiting_for_reset` job with a parseable
 * `resetAt`, sorted soonest-first, optionally trimmed to a `withinMs` window
 * and/or a `limit`. This is exactly the set the scheduler's due logic acts on,
 * ordered — so `upcoming` shows the daemon's next several moves without
 * duplicating queue internals. Returns an empty array when nothing is waiting.
 *
 * Pure: no clock (unless `now` is omitted), no queue, no I/O — fully
 * unit-testable. Scope filtering (tool/project/etc.) is left to the caller via
 * `scopeJobs`, keeping this focused on the reset-timeline concern.
 */
export function selectUpcoming(jobs: RelayJob[], options: UpcomingOptions = {}): UpcomingResume[] {
  const now = options.now ?? Date.now();
  const withinMs = options.withinMs ?? null;

  const entries = jobs
    .filter(
      (job) => job.status === "waiting_for_reset" && job.resetAt !== null && !Number.isNaN(Date.parse(job.resetAt))
    )
    .map((job) => {
      const resetMs = Date.parse(job.resetAt as string);
      return { job, dueInMs: resetMs - now, due: resetMs <= now } satisfies UpcomingResume;
    });

  entries.sort((a, b) => compareUpcoming(a.job, b.job));

  const windowed = withinMs !== null && withinMs >= 0 ? entries.filter((entry) => entry.dueInMs <= withinMs) : entries;

  const limit = options.limit ?? null;
  return limit !== null && limit >= 0 ? windowed.slice(0, limit) : windowed;
}
