import type { RelayJob } from "./types.js";

/**
 * The single job the relay will resume next, plus a bit of derived context.
 * Computed purely from the job list and an injected `now` (epoch ms) — no
 * clock, no queue, no I/O — so `agentrelay next` is unit-testable end to end.
 */
export interface NextResume {
  /** The job with the earliest reset time still waiting to be resumed. */
  job: RelayJob;
  /** Milliseconds from `now` until its reset; zero/negative once it has passed. */
  dueInMs: number;
  /** True once the reset time has passed — a scheduler tick would pick it up now. */
  due: boolean;
  /** How many other jobs are also waiting for a reset behind this one. */
  waitingBehind: number;
}

/**
 * One row in the upcoming-resume agenda: a waiting job with its derived due
 * state. Unlike {@link NextResume} there is no `waitingBehind` — the list's
 * own ordering (soonest first) already conveys the queue behind each entry.
 */
export interface UpcomingResume {
  /** A job waiting for a reset, with a parseable `resetAt`. */
  job: RelayJob;
  /** Milliseconds from `now` until its reset; zero/negative once it has passed. */
  dueInMs: number;
  /** True once the reset time has passed — a scheduler tick would pick it up now. */
  due: boolean;
}

/**
 * Order two waiting jobs by which the scheduler will resume first: earliest
 * reset time wins, then oldest `createdAt`, then id — so the pick is fully
 * deterministic even when two jobs share a reset time.
 */
function compareNext(a: RelayJob, b: RelayJob): number {
  const ra = Date.parse(a.resetAt as string);
  const rb = Date.parse(b.resetAt as string);
  if (ra !== rb) return ra - rb;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * The jobs the scheduler can actually resume: `waiting_for_reset` with a
 * parseable `resetAt` (a null/`"not-a-date"` resetAt can never come due), sorted
 * soonest-first. This is the single filter+sort both `selectNextResume` and
 * `selectUpcomingResumes` build on, so "the next one" and "the next N" can never
 * disagree about which jobs count or in what order.
 */
function sortedWaiting(jobs: RelayJob[]): RelayJob[] {
  return jobs
    .filter(
      (job) => job.status === "waiting_for_reset" && job.resetAt !== null && !Number.isNaN(Date.parse(job.resetAt))
    )
    .sort(compareNext);
}

/**
 * Find the next job the relay will resume: the `waiting_for_reset` job with a
 * parseable `resetAt` that comes due soonest. This is exactly the set the
 * scheduler's `listDue` acts on, so `next` answers "what's the daemon's next
 * move?" without duplicating the queue's due logic. Returns null when nothing
 * is waiting for a reset (an empty queue, or only active/terminal jobs).
 */
export function selectNextResume(jobs: RelayJob[], now: number = Date.now()): NextResume | null {
  const waiting = sortedWaiting(jobs);
  if (waiting.length === 0) return null;

  const job = waiting[0];
  const resetMs = Date.parse(job.resetAt as string);
  return {
    job,
    dueInMs: resetMs - now,
    due: resetMs <= now,
    waitingBehind: waiting.length - 1,
  };
}

/**
 * The upcoming-resume agenda: every job waiting for a reset, ordered exactly as
 * the scheduler will resume them (soonest first), optionally capped to the first
 * `limit`. Where {@link selectNextResume} answers "what's next?", this answers
 * "what's the schedule?" — a mini timeline for `agentrelay next --limit N`.
 *
 * Pure: driven only by the job list and an injected `now`. `limit` <= 0 (or
 * omitted) returns the whole ordered list; a non-integer limit is floored.
 * Returns an empty array when nothing is waiting for a reset.
 */
export function selectUpcomingResumes(jobs: RelayJob[], now: number = Date.now(), limit?: number): UpcomingResume[] {
  const waiting = sortedWaiting(jobs);
  const capped =
    limit !== undefined && Number.isFinite(limit) && limit > 0 ? waiting.slice(0, Math.floor(limit)) : waiting;
  return capped.map((job) => {
    const resetMs = Date.parse(job.resetAt as string);
    return { job, dueInMs: resetMs - now, due: resetMs <= now };
  });
}
