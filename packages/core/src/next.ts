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
 * Sort key for a waiting job's reset time. An **unparseable** `resetAt` mirrors
 * `isJobDue`: the scheduler treats it as due now, so it is the most urgent and
 * sorts ahead of every real timestamp (`NEGATIVE_INFINITY`). Callers exclude a
 * `null` `resetAt` before this runs, so it only ever sees a string.
 */
function resetSortKey(job: RelayJob): number {
  const ms = Date.parse(job.resetAt as string);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Order two waiting jobs by which the scheduler will resume first: earliest
 * reset time wins, then oldest `createdAt`, then id — so the pick is fully
 * deterministic even when two jobs share a reset time.
 */
function compareNext(a: RelayJob, b: RelayJob): number {
  const ra = resetSortKey(a);
  const rb = resetSortKey(b);
  if (ra !== rb) return ra - rb;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Find the next job the relay will resume: the `waiting_for_reset` job that
 * comes due soonest. This is exactly the set the scheduler's `listDue` acts on
 * (see `isJobDue`), so `next` answers "what's the daemon's next move?" without
 * duplicating the queue's due logic. A job with an **unparseable** `resetAt` is
 * surfaced as due now — not filtered out — because `listDue` will resume it on
 * the next tick; hiding it would leave `next` silently disagreeing with what the
 * daemon actually does. A `null` `resetAt` is excluded (the job isn't genuinely
 * parked on a reset), matching `isJobDue`. Returns null when nothing is waiting
 * for a reset (an empty queue, or only active/terminal jobs).
 */
export function selectNextResume(jobs: RelayJob[], now: number = Date.now()): NextResume | null {
  const waiting = jobs.filter((job) => job.status === "waiting_for_reset" && job.resetAt !== null);
  if (waiting.length === 0) return null;

  const job = waiting.reduce((best, candidate) => (compareNext(candidate, best) < 0 ? candidate : best));
  const resetMs = Date.parse(job.resetAt as string);
  // Unparseable reset → due now (mirrors `isJobDue`): report a 0ms countdown
  // rather than a NaN a renderer would mangle.
  const unparseable = Number.isNaN(resetMs);
  return {
    job,
    dueInMs: unparseable ? 0 : resetMs - now,
    due: unparseable ? true : resetMs <= now,
    waitingBehind: waiting.length - 1,
  };
}
