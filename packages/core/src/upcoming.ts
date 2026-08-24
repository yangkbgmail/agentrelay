import type { RelayJob } from "./types.js";

/**
 * One waiting job in the upcoming-resume timeline, plus the context the CLI
 * needs to render a countdown row. Computed purely from the job list and an
 * injected `now` (epoch ms) — no clock, no queue, no I/O — so `agentrelay
 * upcoming` is unit-testable end to end.
 */
export interface UpcomingEntry {
  /** The waiting job this row describes. */
  job: RelayJob;
  /** Milliseconds from `now` until its reset; zero/negative once it has passed. */
  dueInMs: number;
  /** True once the reset time has passed — a scheduler tick would pick it up now. */
  due: boolean;
  /** 1-based position in the resume order (1 = resumes next). */
  position: number;
}

/**
 * The forward-looking timeline the relay will work through: every
 * `waiting_for_reset` job ordered by when it comes due. Where `next` answers
 * "what's the single next move?", `upcoming` shows the whole runway so you can
 * see what's queued behind it and when each lands.
 */
export interface UpcomingTimeline {
  /** Ordered rows, soonest-due first. Trimmed to `limit` when one was given. */
  entries: UpcomingEntry[];
  /** How many jobs are waiting for a reset in total (before any `limit` trim). */
  totalWaiting: number;
  /** How many waiting jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** How many of the waiting jobs are already due now (a tick would resume them). */
  dueNow: number;
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
 * reset time wins, then oldest `createdAt`, then id — so the ordering is fully
 * deterministic even when two jobs share a reset time. This matches
 * `selectNextResume`'s tie-break exactly, so `upcoming`'s first row is always
 * the same job `next` reports.
 */
function compareUpcoming(a: RelayJob, b: RelayJob): number {
  const ra = resetSortKey(a);
  const rb = resetSortKey(b);
  if (ra !== rb) return ra - rb;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the upcoming-resume timeline: the `waiting_for_reset` jobs, sorted by
 * when they come due. This is exactly the set the scheduler's `listDue` acts on
 * (see `isJobDue`), so `upcoming` mirrors "what the daemon will do next, and
 * after that" without duplicating the queue's due logic. A job with an
 * **unparseable** `resetAt` is surfaced as due now — not filtered out — because
 * `listDue` will resume it on the next tick; hiding it would leave `upcoming`
 * silently disagreeing with what the daemon actually does. A `null` `resetAt`
 * is excluded (the job isn't genuinely parked on a reset), matching `isJobDue`.
 *
 * `limit` (when a positive integer) trims the returned `entries` to the
 * soonest N, but `totalWaiting`/`dueNow` still reflect the full set so callers
 * can honestly report "N more not shown".
 */
export function buildUpcomingTimeline(jobs: RelayJob[], now: number = Date.now(), limit?: number): UpcomingTimeline {
  const waiting = jobs
    .filter((job) => job.status === "waiting_for_reset" && job.resetAt !== null)
    .sort(compareUpcoming);

  const totalWaiting = waiting.length;
  // An unparseable reset counts as due now (mirrors `isJobDue`); `NaN <= now`
  // would otherwise miscount it as not-yet-due.
  const isDueNow = (job: RelayJob): boolean => {
    const resetMs = Date.parse(job.resetAt as string);
    return Number.isNaN(resetMs) || resetMs <= now;
  };
  const dueNow = waiting.filter(isDueNow).length;

  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? waiting.slice(0, limit) : waiting;

  const entries: UpcomingEntry[] = capped.map((job, index) => {
    const resetMs = Date.parse(job.resetAt as string);
    const unparseable = Number.isNaN(resetMs);
    return {
      job,
      dueInMs: unparseable ? 0 : resetMs - now,
      due: unparseable ? true : resetMs <= now,
      position: index + 1,
    };
  });

  return {
    entries,
    totalWaiting,
    hidden: totalWaiting - entries.length,
    dueNow,
  };
}
