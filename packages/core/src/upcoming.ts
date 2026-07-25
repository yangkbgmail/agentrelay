import { compareByResume } from "./next.js";
import type { RelayJob } from "./types.js";

/**
 * One entry in the resume schedule: a job the relay is waiting to resume, plus
 * the derived countdown state. Same shape `next` exposes for its single head,
 * so a scripted consumer reads `upcoming` and `next` items identically.
 */
export interface UpcomingResume {
  /** A `waiting_for_reset` job with a parseable `resetAt`. */
  job: RelayJob;
  /** Milliseconds from `now` until its reset; zero/negative once it has passed. */
  dueInMs: number;
  /** True once the reset time has passed — a scheduler tick would pick it up now. */
  due: boolean;
}

/**
 * The full (optionally truncated) resume schedule. Where `next` answers "what's
 * the daemon's very next move?", `upcoming` answers "what's the whole runway?" —
 * every waiting job in the order the scheduler will resume them, with a due-now
 * count and a hidden count so a `--limit` view can honestly say how much it
 * elided.
 */
export interface UpcomingSchedule {
  /** Resumes in scheduler order, earliest reset first; truncated to `limit` when given. */
  resumes: UpcomingResume[];
  /** Total jobs waiting for a reset before any `limit` truncation. */
  totalWaiting: number;
  /** How many of the total are already due (reset time has passed). */
  dueNow: number;
  /** How many waiting jobs are not in `resumes` because of `limit` (0 when untruncated). */
  hidden: number;
}

/**
 * Options for {@link selectUpcomingResumes}.
 */
export interface UpcomingOptions {
  /** Keep only the first N resumes (still reports the full `totalWaiting`/`hidden`). Non-positive/omitted = no limit. */
  limit?: number;
}

/**
 * Build the relay's resume schedule: every `waiting_for_reset` job with a
 * parseable `resetAt`, sorted by exactly the rule `next` uses to pick its head
 * ({@link compareByResume} — earliest reset, then oldest, then id). Pure:
 * computed from the job list and an injected `now` (epoch ms) with no clock,
 * queue, or I/O, so `agentrelay upcoming` is unit-testable end to end.
 *
 * `limit` truncates the returned rows but never the accounting: `totalWaiting`,
 * `dueNow`, and `hidden` always reflect the full waiting set, so a truncated
 * view can say "N more not shown" truthfully.
 */
export function selectUpcomingResumes(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: UpcomingOptions = {}
): UpcomingSchedule {
  const waiting = jobs
    .filter(
      (job) => job.status === "waiting_for_reset" && job.resetAt !== null && !Number.isNaN(Date.parse(job.resetAt))
    )
    .sort(compareByResume);

  const all: UpcomingResume[] = waiting.map((job) => {
    const resetMs = Date.parse(job.resetAt as string);
    return { job, dueInMs: resetMs - now, due: resetMs <= now };
  });

  const dueNow = all.reduce((count, r) => (r.due ? count + 1 : count), 0);

  const limit = options.limit;
  const truncated = limit !== undefined && limit > 0 ? all.slice(0, limit) : all;

  return {
    resumes: truncated,
    totalWaiting: all.length,
    dueNow,
    hidden: all.length - truncated.length,
  };
}
