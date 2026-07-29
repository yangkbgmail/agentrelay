import { compareResumeOrder } from "./next.js";
import type { RelayJob } from "./types.js";

/**
 * One row of the resume timeline: a job waiting for its rate limit to reset,
 * plus the derived timing the CLI renders. Where `next` answers "what resumes
 * next?" with a single job, `upcoming` answers "what does the whole resume
 * schedule look like?" — every waiting job in the order the scheduler will pick
 * them, with the gap between consecutive resumes so you can see the cadence.
 */
export interface UpcomingResume {
  /** The waiting job. */
  job: RelayJob;
  /** Its reset time as epoch ms (guaranteed parseable — unparseable jobs are dropped). */
  resetAtMs: number;
  /** Milliseconds from `now` until the reset; zero/negative once it has passed. */
  dueInMs: number;
  /** True once the reset time has passed — a scheduler tick would resume it now. */
  due: boolean;
  /**
   * Milliseconds between this resume and the previous entry's resume in the
   * timeline (0 for the first entry). Reveals the cadence — clustered resets vs
   * spread-out ones — which a flat status table doesn't show.
   */
  gapFromPreviousMs: number;
}

/**
 * The resume timeline: the ordered upcoming resumes plus a bit of context so a
 * `--limit`ed view can still report the true totals.
 */
export interface UpcomingResumes {
  /** Entries in resume order, capped by `limit` when one is given. */
  entries: UpcomingResume[];
  /** How many jobs are waiting for a reset in total (before any `limit`). */
  totalWaiting: number;
  /** How many entries are shown (`entries.length`; ≤ `totalWaiting`). */
  shown: number;
  /**
   * Span from the first to the last shown resume, in ms — the width of the
   * window you're looking at. Null when fewer than two entries are shown (a
   * single point has no span).
   */
  spanMs: number | null;
}

/** A waiting job with a parseable reset time is one the scheduler can actually act on. */
function isResumable(job: RelayJob): job is RelayJob & { resetAt: string } {
  return job.status === "waiting_for_reset" && job.resetAt !== null && !Number.isNaN(Date.parse(job.resetAt));
}

/**
 * Build the resume timeline from the job list: every `waiting_for_reset` job
 * with a parseable `resetAt`, ordered exactly as the scheduler will resume them
 * (earliest reset first, then oldest `createdAt`, then id — shared with `next`
 * via {@link compareResumeOrder}), each annotated with its countdown and the
 * gap since the previous resume. `limit` (when a positive integer) caps how many
 * entries are returned while `totalWaiting` still reflects the full set. Pure:
 * `now` is injected, no clock/queue/I-O — so `agentrelay upcoming` is unit
 * testable end to end.
 */
export function selectUpcomingResumes(
  jobs: RelayJob[],
  options: { now?: number; limit?: number } = {}
): UpcomingResumes {
  const now = options.now ?? Date.now();

  const waiting = jobs.filter(isResumable).sort(compareResumeOrder);
  const totalWaiting = waiting.length;

  // A non-positive or non-integer limit means "no cap" — callers validate/clamp
  // upstream, but be defensive so a stray 0 doesn't silently hide everything.
  const limited =
    typeof options.limit === "number" && Number.isInteger(options.limit) && options.limit > 0
      ? waiting.slice(0, options.limit)
      : waiting;

  let previousResetMs: number | null = null;
  const entries: UpcomingResume[] = limited.map((job) => {
    const resetAtMs = Date.parse(job.resetAt);
    const gapFromPreviousMs = previousResetMs === null ? 0 : resetAtMs - previousResetMs;
    previousResetMs = resetAtMs;
    return {
      job,
      resetAtMs,
      dueInMs: resetAtMs - now,
      due: resetAtMs <= now,
      gapFromPreviousMs,
    };
  });

  const spanMs = entries.length >= 2 ? entries[entries.length - 1].resetAtMs - entries[0].resetAtMs : null;

  return { entries, totalWaiting, shown: entries.length, spanMs };
}
