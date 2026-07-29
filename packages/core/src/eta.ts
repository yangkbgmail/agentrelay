import type { RelayJob } from "./types.js";

/**
 * The queue-drain forecast: when the relay will have caught up on *every* job
 * currently waiting for a reset. Where `next` (see `next.ts`) answers "which
 * single job resumes soonest?", `eta` answers the complementary question
 * "when is my whole backlog unblocked?" — the latest reset among all waiting
 * jobs. Computed purely from the job list and an injected `now` (epoch ms) —
 * no clock, no queue, no I/O — so `agentrelay eta` is unit-testable end to end.
 */
export interface QueueEta {
  /** How many jobs are waiting for a reset (with a parseable `resetAt`). */
  waitingCount: number;
  /** Raw `resetAt` of the job that comes due soonest — same pick as `next`. */
  firstResetAt: string;
  /** Milliseconds from `now` until the first reset; zero/negative once passed. */
  firstDueInMs: number;
  /** Raw `resetAt` of the last waiting job to come due — the "all clear" moment. */
  lastResetAt: string;
  /** Milliseconds from `now` until the last reset; zero/negative once passed. */
  lastDueInMs: number;
  /** How many waiting jobs are already due (their reset time has passed). */
  dueNow: number;
  /** True once every waiting job is due — a tick would drain the whole backlog. */
  allDue: boolean;
}

/**
 * Forecast when the relay's waiting backlog fully clears. Acts on exactly the
 * set the scheduler resumes — `waiting_for_reset` jobs with a parseable
 * `resetAt` — so `eta` never disagrees with what the daemon actually does.
 * Returns null when nothing is waiting (an empty queue, or only active/terminal
 * jobs), matching `selectNextResume`'s contract.
 */
export function computeQueueEta(jobs: RelayJob[], now: number = Date.now()): QueueEta | null {
  let first: { at: string; ms: number } | null = null;
  let last: { at: string; ms: number } | null = null;
  let waitingCount = 0;
  let dueNow = 0;

  for (const job of jobs) {
    if (job.status !== "waiting_for_reset" || job.resetAt === null) continue;
    const ms = Date.parse(job.resetAt);
    if (Number.isNaN(ms)) continue;

    waitingCount += 1;
    if (ms <= now) dueNow += 1;
    if (first === null || ms < first.ms) first = { at: job.resetAt, ms };
    if (last === null || ms > last.ms) last = { at: job.resetAt, ms };
  }

  if (first === null || last === null) return null;

  return {
    waitingCount,
    firstResetAt: first.at,
    firstDueInMs: first.ms - now,
    lastResetAt: last.at,
    lastDueInMs: last.ms - now,
    dueNow,
    allDue: last.ms <= now,
  };
}
