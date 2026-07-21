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
 * A job the scheduler can actually resume: waiting for a reset with a
 * parseable `resetAt`. Jobs with a null/garbage `resetAt` can't be placed on
 * the resume timeline, so both `next` and `upcoming` ignore them.
 */
function isWaitingForReset(job: RelayJob): boolean {
  return job.status === "waiting_for_reset" && job.resetAt !== null && !Number.isNaN(Date.parse(job.resetAt));
}

/**
 * Find the next job the relay will resume: the `waiting_for_reset` job with a
 * parseable `resetAt` that comes due soonest. This is exactly the set the
 * scheduler's `listDue` acts on, so `next` answers "what's the daemon's next
 * move?" without duplicating the queue's due logic. Returns null when nothing
 * is waiting for a reset (an empty queue, or only active/terminal jobs).
 */
export function selectNextResume(jobs: RelayJob[], now: number = Date.now()): NextResume | null {
  const waiting = jobs.filter(isWaitingForReset);
  if (waiting.length === 0) return null;

  const job = waiting.reduce((best, candidate) => (compareNext(candidate, best) < 0 ? candidate : best));
  const resetMs = Date.parse(job.resetAt as string);
  return {
    job,
    dueInMs: resetMs - now,
    due: resetMs <= now,
    waitingBehind: waiting.length - 1,
  };
}

/**
 * One entry in the upcoming-resume schedule: a job waiting for a reset, its
 * 1-based position in resume order, and the same derived due state
 * ({@link NextResume}) so callers don't recompute countdowns.
 */
export interface UpcomingResume {
  /** A job waiting for its rate limit to reset. */
  job: RelayJob;
  /** Milliseconds from `now` until its reset; zero/negative once it has passed. */
  dueInMs: number;
  /** True once the reset time has passed — a scheduler tick would pick it up now. */
  due: boolean;
  /** 1-based position in the resume order (1 = the very next resume). */
  position: number;
}

/**
 * The full upcoming-resume schedule: `entries` in the exact order the
 * scheduler will resume them, plus how many jobs are waiting in total so the
 * caller can note what a `limit` hid.
 */
export interface UpcomingResumes {
  /** Waiting jobs in resume order (soonest first), capped by `limit`. */
  entries: UpcomingResume[];
  /** Total jobs waiting for a reset, before any `limit` truncation. */
  totalWaiting: number;
  /** True when `limit` hid some waiting jobs from `entries`. */
  truncated: boolean;
}

/**
 * Build the resume schedule: every `waiting_for_reset` job with a parseable
 * `resetAt`, ordered exactly as the scheduler will resume them (soonest reset
 * first, ties broken by `createdAt` then id — same order `next` uses to pick
 * the single head). Where `next` answers "what resumes next?", `upcoming`
 * answers "what's the whole queue of pending resumes, and when?". Pure: no
 * clock, no queue, no I/O when `now` is supplied, and the input array is not
 * mutated. A non-positive/absent `limit` returns every waiting job.
 */
export function selectUpcomingResumes(
  jobs: RelayJob[],
  options: { now?: number; limit?: number } = {}
): UpcomingResumes {
  const now = options.now ?? Date.now();
  const ordered = jobs.filter(isWaitingForReset).sort(compareNext);
  const totalWaiting = ordered.length;

  const hasLimit = typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit >= 0;
  const capped = hasLimit ? ordered.slice(0, options.limit as number) : ordered;

  const entries: UpcomingResume[] = capped.map((job, index) => {
    const resetMs = Date.parse(job.resetAt as string);
    return {
      job,
      dueInMs: resetMs - now,
      due: resetMs <= now,
      position: index + 1,
    };
  });

  return { entries, totalWaiting, truncated: totalWaiting > entries.length };
}
