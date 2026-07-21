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

/** One waiting job in an upcoming-resume schedule, with its derived due state. */
export interface UpcomingResume {
  /** A `waiting_for_reset` job with a parseable `resetAt`. */
  job: RelayJob;
  /** Milliseconds from `now` until its reset; zero/negative once it has passed. */
  dueInMs: number;
  /** True once the reset time has passed — a scheduler tick would pick it up now. */
  due: boolean;
}

/**
 * An ordered look-ahead at the relay's next resumes. Where {@link NextResume}
 * answers "what's next?", this answers "what are the next few, and when?" — a
 * schedule/timeline view for a status bar or `agentrelay next --count N`.
 */
export interface UpcomingResumes {
  /** Resumes soonest-first, capped at the requested limit. */
  entries: UpcomingResume[];
  /** Every `waiting_for_reset` job with a parseable `resetAt` (may exceed `entries`). */
  totalWaiting: number;
  /** How many waiting jobs are not shown (`totalWaiting - entries.length`). */
  more: number;
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
 * Find the next job the relay will resume: the `waiting_for_reset` job with a
 * parseable `resetAt` that comes due soonest. This is exactly the set the
 * scheduler's `listDue` acts on, so `next` answers "what's the daemon's next
 * move?" without duplicating the queue's due logic. Returns null when nothing
 * is waiting for a reset (an empty queue, or only active/terminal jobs).
 */
export function selectNextResume(jobs: RelayJob[], now: number = Date.now()): NextResume | null {
  const waiting = jobs.filter(isWaitingForResume);
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

/** True when a job is waiting for a reset with a resetAt the scheduler can act on. */
function isWaitingForResume(job: RelayJob): boolean {
  return job.status === "waiting_for_reset" && job.resetAt !== null && !Number.isNaN(Date.parse(job.resetAt));
}

/**
 * Look ahead at the next several resumes, not just the single soonest one.
 * Returns every `waiting_for_reset` job with a parseable `resetAt` ordered by
 * the same rule the scheduler uses ({@link compareNext}), capped at `limit`
 * (a positive integer; `undefined` returns all, and `limit <= 0` returns none
 * while still reporting the full waiting count in `more`). Pure: driven only by
 * the job list and an injected `now`, so `agentrelay next --count N` is fully
 * unit-testable.
 */
export function selectUpcomingResumes(
  jobs: RelayJob[],
  options: { now?: number; limit?: number } = {}
): UpcomingResumes {
  const now = options.now ?? Date.now();
  const waiting = jobs.filter(isWaitingForResume).sort(compareNext);
  const totalWaiting = waiting.length;

  // `undefined` = no cap (show all); a numeric limit clamps to [0, totalWaiting]
  // so a huge --count never invents rows and a non-positive one shows none.
  const capped = options.limit === undefined ? waiting : waiting.slice(0, Math.max(0, Math.trunc(options.limit)));

  const entries: UpcomingResume[] = capped.map((job) => {
    const resetMs = Date.parse(job.resetAt as string);
    return { job, dueInMs: resetMs - now, due: resetMs <= now };
  });

  return { entries, totalWaiting, more: totalWaiting - entries.length };
}
