import { compareNextResume } from "./next.js";
import type { RelayJob } from "./types.js";

/**
 * One entry in the resume timeline: a `waiting_for_reset` job plus how long
 * until its reset comes due. Where {@link selectNextResume} answers "what's the
 * single next move?", `upcoming` lists the whole ordered queue of pending
 * resumes so you can see the full schedule at a glance.
 */
export interface UpcomingResume {
  /** A job waiting for its rate-limit reset, with a parseable `resetAt`. */
  job: RelayJob;
  /** Milliseconds from `now` until its reset; zero/negative once it has passed. */
  dueInMs: number;
  /** True once the reset time has passed — a scheduler tick would pick it up now. */
  due: boolean;
}

/**
 * The upcoming-resume timeline: the entries actually shown (after an optional
 * `limit`), the total number of jobs waiting for a reset, and how many were
 * hidden by the limit. `hidden` is always `totalWaiting - entries.length`, so a
 * renderer can print an accurate "N more waiting" footer.
 */
export interface UpcomingResumes {
  /** Waiting jobs ordered by reset time (soonest first), capped by `limit`. */
  entries: UpcomingResume[];
  /** Total `waiting_for_reset` jobs with a parseable `resetAt` (before `limit`). */
  totalWaiting: number;
  /** How many waiting jobs the `limit` left out (0 when everything is shown). */
  hidden: number;
}

/**
 * Build the ordered timeline of jobs the relay will resume: every
 * `waiting_for_reset` job with a parseable `resetAt`, sorted soonest-first with
 * the same deterministic tiebreak the scheduler uses (reset time → createdAt →
 * id, via {@link compareNextResume}). Pure — computed only from the job list and
 * an injected `now` (epoch ms), no clock/queue/I/O — so `agentrelay upcoming` is
 * unit-testable end to end.
 *
 * `limit` (when a positive integer) caps `entries` to the soonest N; anything
 * below 1 or non-integer is ignored (no cap), matching the CLI's own validation.
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
    .sort(compareNextResume);

  const totalWaiting = waiting.length;

  const shown =
    options.limit !== undefined && Number.isInteger(options.limit) && options.limit >= 1
      ? waiting.slice(0, options.limit)
      : waiting;

  const entries: UpcomingResume[] = shown.map((job) => {
    const resetMs = Date.parse(job.resetAt as string);
    return { job, dueInMs: resetMs - now, due: resetMs <= now };
  });

  return { entries, totalWaiting, hidden: totalWaiting - entries.length };
}
