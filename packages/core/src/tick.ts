import type { RelayJob } from "./types.js";

/**
 * One job the *next* scheduler tick would resume: a `waiting_for_reset` job
 * whose `resetAt` has already passed at the reference time. This is the exact
 * unit the scheduler's `resume()` acts on, surfaced ahead of time so operators
 * can preview a tick without spawning anything.
 */
export interface PlannedResume {
  /** The due job that would be resumed. */
  job: RelayJob;
  /** How long ago the reset time passed, in ms (always >= 0). */
  overdueByMs: number;
}

/**
 * A read-only preview of what a single scheduler tick would do *right now* —
 * the operational mirror of the scheduler's own `listDue`. Where `overdue` is a
 * grace-gated *health* signal ("what should already have run?") and `upcoming`
 * shows the forward runway, `planTick` answers the operator's pre-flight
 * question: "if I run `agentrelay tick` this instant, which jobs get resumed?".
 *
 * The scheduler resumes *every* due job within one tick (its `maxConcurrent`
 * only bounds how many run simultaneously, not how many run at all), so the plan
 * is the complete set the tick would act on — nothing is deferred to a later
 * pass.
 *
 * Computed purely from the job list and an injected `now` (epoch ms) — no clock,
 * no queue, no spawn — so `agentrelay tick --dry-run` is unit-testable end to
 * end and provably free of side effects.
 */
export interface TickPlan {
  /** Jobs the tick would resume, most-overdue first. */
  resumes: PlannedResume[];
  /** How many jobs would be resumed (== `resumes.length`; a convenience total). */
  total: number;
  /** The reference time the plan was computed against, epoch ms. */
  referenceTimeMs: number;
}

/**
 * Order two due jobs most-overdue-first: the one whose reset passed longest ago
 * comes first, then oldest `createdAt`, then id — fully deterministic even when
 * two jobs share a reset time. This matches the tie-break `overdue` uses so the
 * two surfaces rank an identical job set identically.
 */
function compareDue(a: RelayJob, b: RelayJob): number {
  const ra = Date.parse(a.resetAt as string);
  const rb = Date.parse(b.resetAt as string);
  // Earlier resetAt = longer overdue = should sort first.
  if (ra !== rb) return ra - rb;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the tick plan: every `waiting_for_reset` job with a parseable `resetAt`
 * that is at or past `now`, ranked most-overdue first. The selection predicate
 * is deliberately identical to the scheduler's `listDue`
 * (`status === "waiting_for_reset" && resetAt !== null && resetMs <= now`) — no
 * grace window, unlike `overdue` — so the preview is a faithful "this is exactly
 * what the tick will resume" rather than an approximation.
 */
export function planTick(jobs: RelayJob[], now: number = Date.now()): TickPlan {
  const due = jobs
    .filter((job) => {
      if (job.status !== "waiting_for_reset" || job.resetAt === null) return false;
      const resetMs = Date.parse(job.resetAt);
      if (Number.isNaN(resetMs)) return false;
      return resetMs <= now;
    })
    .sort(compareDue);

  const resumes: PlannedResume[] = due.map((job) => ({
    job,
    overdueByMs: now - Date.parse(job.resetAt as string),
  }));

  return { resumes, total: resumes.length, referenceTimeMs: now };
}
