import type { RelayJob } from "./types.js";

/**
 * "When is the whole queue caught up?" — where `next` (soonest reset) answers
 * *what resumes first* and `upcoming` lists the runway, `eta` answers the
 * complementary question: how long until the *last* waiting job has resumed and
 * there is nothing left for the relay to wait on. That's the **latest** reset
 * time among the jobs the scheduler still has to pick up. Computed purely from
 * the job list and an injected `now` (epoch ms) — no clock, no queue, no I/O —
 * so `agentrelay eta` is unit-testable end to end.
 */
export interface QueueEta {
  /** Number of `waiting_for_reset` jobs with a parseable `resetAt`. */
  waiting: number;
  /** How many of those are already past due (a tick would pick them up now). */
  dueNow: number;
  /** Soonest reset among the waiting jobs (ISO), or null when none are waiting. */
  firstResetAt: string | null;
  /** Latest reset among the waiting jobs (ISO) — the moment the queue is caught up. */
  lastResetAt: string | null;
  /**
   * Milliseconds from `now` until `lastResetAt` — how long until the queue is
   * fully caught up. Zero/negative once the last reset has already passed
   * (everything is due but the loop hasn't run yet). Null when nothing waits.
   */
  etaMs: number | null;
  /**
   * Span between the soonest and latest reset (`lastResetAt - firstResetAt`, ms)
   * — how spread out the resumptions are. Zero when a single job waits (or all
   * share a reset time). Null when nothing waits.
   */
  spanMs: number | null;
  /** True when no job is waiting for a reset — the relay has nothing pending. */
  caughtUp: boolean;
}

/**
 * The same set the scheduler's `listDue` acts on: `waiting_for_reset` jobs with
 * a parseable `resetAt`. Keeping this filter identical to `next`/`upcoming`
 * means all three surfaces agree on "what is the relay actually waiting on".
 */
function waitingResets(jobs: RelayJob[]): number[] {
  const resets: number[] = [];
  for (const job of jobs) {
    if (job.status !== "waiting_for_reset" || job.resetAt === null) continue;
    const ms = Date.parse(job.resetAt);
    if (!Number.isNaN(ms)) resets.push(ms);
  }
  return resets;
}

/**
 * Compute the queue's catch-up ETA: the countdown to the latest reset among all
 * waiting jobs. Returns a `caughtUp` report (all null fields) when nothing is
 * waiting for a reset — an empty queue, or only active/terminal jobs.
 */
export function computeQueueEta(jobs: RelayJob[], now: number = Date.now()): QueueEta {
  const resets = waitingResets(jobs);
  if (resets.length === 0) {
    return {
      waiting: 0,
      dueNow: 0,
      firstResetAt: null,
      lastResetAt: null,
      etaMs: null,
      spanMs: null,
      caughtUp: true,
    };
  }

  let min = resets[0];
  let max = resets[0];
  let dueNow = 0;
  for (const ms of resets) {
    if (ms < min) min = ms;
    if (ms > max) max = ms;
    if (ms <= now) dueNow += 1;
  }

  return {
    waiting: resets.length,
    dueNow,
    firstResetAt: new Date(min).toISOString(),
    lastResetAt: new Date(max).toISOString(),
    etaMs: max - now,
    spanMs: max - min,
    caughtUp: false,
  };
}
