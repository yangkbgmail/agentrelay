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
 * Find the next job the relay will resume: the `waiting_for_reset` job with a
 * parseable `resetAt` that comes due soonest. This is exactly the set the
 * scheduler's `listDue` acts on, so `next` answers "what's the daemon's next
 * move?" without duplicating the queue's due logic. Returns null when nothing
 * is waiting for a reset (an empty queue, or only active/terminal jobs).
 */
export function selectNextResume(jobs: RelayJob[], now: number = Date.now()): NextResume | null {
  const waiting = jobs.filter(
    (job) => job.status === "waiting_for_reset" && job.resetAt !== null && !Number.isNaN(Date.parse(job.resetAt))
  );
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

/** One row of the resume timeline: a waiting job plus its derived due state. */
export interface UpcomingResume {
  /** A `waiting_for_reset` job with a parseable `resetAt`. */
  job: RelayJob;
  /** Milliseconds from `now` until its reset; zero/negative once it has passed. */
  dueInMs: number;
  /** True once the reset time has passed — a scheduler tick would pick it up now. */
  due: boolean;
}

/**
 * The full "what resumes next, and when" agenda derived from the job list.
 * Counts are over *all* waiting jobs (before any `limit`), so a truncated view
 * can still say how many are hidden and how many are already due.
 */
export interface UpcomingResumes {
  /** Waiting jobs in resume order (soonest first), truncated to `limit` if given. */
  entries: UpcomingResume[];
  /** How many jobs are waiting for a reset in total (before `limit`). */
  totalWaiting: number;
  /** How many of those waiting jobs are already due (reset time has passed). */
  dueNow: number;
}

/**
 * Build the resume timeline: every `waiting_for_reset` job with a parseable
 * `resetAt`, ordered exactly like {@link selectNextResume} would pick them
 * (earliest reset, then oldest `createdAt`, then id) so `upcoming` and `next`
 * never disagree about who's first. Where `next` answers "which one?" and
 * `status` lists the whole queue (including active/terminal noise), this is the
 * focused agenda of what the daemon will actually resume, and in what order.
 *
 * Pure: no clock, no queue, no I/O. `now` (epoch ms) and `limit` are injectable
 * so the command is unit-testable end to end. A non-positive `limit` yields no
 * rows while the counts still reflect the full waiting set.
 */
export function selectUpcomingResumes(
  jobs: RelayJob[],
  options: { now?: number; limit?: number } = {}
): UpcomingResumes {
  const now = options.now ?? Date.now();
  const waiting = jobs
    .filter(
      (job) => job.status === "waiting_for_reset" && job.resetAt !== null && !Number.isNaN(Date.parse(job.resetAt))
    )
    .sort(compareNext);

  const all: UpcomingResume[] = waiting.map((job) => {
    const resetMs = Date.parse(job.resetAt as string);
    return { job, dueInMs: resetMs - now, due: resetMs <= now };
  });

  const dueNow = all.reduce((count, entry) => (entry.due ? count + 1 : count), 0);
  const entries = options.limit === undefined ? all : all.slice(0, Math.max(0, options.limit));

  return { entries, totalWaiting: all.length, dueNow };
}
