import type { RelayJob } from "./types.js";

/**
 * The relay's forward-looking resume schedule, grouped into time windows.
 *
 * Where `next` answers "which single job resumes soonest?" and `status` lists
 * the whole queue flat, `agenda` groups every `waiting_for_reset` job by *when*
 * it comes due. That grouping is the point: jobs whose resets land in the same
 * window form a resume "herd" that a scheduler tick will fire all at once —
 * exactly the thundering-herd the resume-stagger knobs exist to spread out.
 * Seeing the herds is the first step to deciding whether staggering is needed.
 *
 * Everything here is a pure function of the job list plus an injected `now`
 * (epoch ms) — no clock, no queue, no I/O — so the whole command is
 * unit-testable end to end.
 */

/** Default bucket width: jobs resuming within the same minute count as a herd. */
export const DEFAULT_AGENDA_WINDOW_MS = 60_000;

/** One waiting job placed on the agenda. */
export interface ResumeAgendaEntry {
  job: RelayJob;
  /** Epoch ms of the job's parsed `resetAt`. */
  resetMs: number;
  /** `resetMs - now`; zero or negative once the reset has passed. */
  dueInMs: number;
}

/** A group of jobs whose resets fall in the same `windowMs`-wide bucket. */
export interface ResumeWindow {
  /**
   * Epoch ms of the window's start, floored to `windowMs`. `null` for the
   * single collapsed bucket of jobs that are already past their reset (they
   * are all effectively "due now" — the next tick picks up the lot).
   */
  windowStart: number | null;
  /** ISO form of {@link windowStart}, or `null` for the due-now bucket. */
  windowStartIso: string | null;
  /** ms from `now` until this window opens; `<= 0` for the due-now bucket. */
  opensInMs: number;
  /** Every job resuming in this window, earliest reset first. */
  entries: ResumeAgendaEntry[];
  /** `entries.length` — a value greater than 1 is a resume herd. */
  count: number;
  /** True for the collapsed bucket of already-due jobs. */
  due: boolean;
}

/** The full agenda: totals plus the (optionally limited) list of windows. */
export interface ResumeAgenda {
  /** The `now` the agenda was computed against (epoch ms). */
  now: number;
  /** Bucket width used to group resets (epoch ms). */
  windowMs: number;
  /** All `waiting_for_reset` jobs with a parseable reset, before any limit. */
  totalWaiting: number;
  /** How many of those are already due (the size of the due-now bucket). */
  dueNow: number;
  /** Windows returned, chronological — the due-now bucket first when present. */
  windows: ResumeWindow[];
  /** Windows dropped by `limit`, if any (the tail of the schedule). */
  hiddenWindows: number;
  /** Total jobs living in those hidden windows. */
  hiddenJobs: number;
}

/**
 * Order two entries by which the scheduler will resume first: earliest reset
 * wins, then oldest `createdAt`, then id — the same deterministic tiebreak
 * `next` uses, so the two commands never disagree about ordering.
 */
function compareEntries(a: ResumeAgendaEntry, b: ResumeAgendaEntry): number {
  if (a.resetMs !== b.resetMs) return a.resetMs - b.resetMs;
  if (a.job.createdAt !== b.job.createdAt) return a.job.createdAt < b.job.createdAt ? -1 : 1;
  if (a.job.id === b.job.id) return 0;
  return a.job.id < b.job.id ? -1 : 1;
}

/**
 * Build the resume agenda from a job list. Only `waiting_for_reset` jobs with a
 * parseable `resetAt` appear (exactly the set the scheduler's `listDue` acts
 * on). Already-due jobs collapse into one `due` bucket; the rest bucket by
 * `floor(resetMs / windowMs)`. `limit`, when given, keeps the earliest N
 * windows and reports the hidden tail so the caller can note it without losing
 * the totals.
 */
export function computeResumeAgenda(
  jobs: RelayJob[],
  options: { now?: number; windowMs?: number; limit?: number } = {}
): ResumeAgenda {
  const now = options.now ?? Date.now();
  // A non-positive or non-finite window would divide badly; fall back to 1ms
  // (every distinct reset instant becomes its own window).
  const windowMs =
    typeof options.windowMs === "number" && Number.isFinite(options.windowMs) && options.windowMs >= 1
      ? Math.floor(options.windowMs)
      : DEFAULT_AGENDA_WINDOW_MS;

  const waiting = jobs.filter(
    (job) => job.status === "waiting_for_reset" && job.resetAt !== null && !Number.isNaN(Date.parse(job.resetAt))
  );

  const dueEntries: ResumeAgendaEntry[] = [];
  const buckets = new Map<number, ResumeAgendaEntry[]>();

  for (const job of waiting) {
    const resetMs = Date.parse(job.resetAt as string);
    const entry: ResumeAgendaEntry = { job, resetMs, dueInMs: resetMs - now };
    if (resetMs <= now) {
      dueEntries.push(entry);
    } else {
      const windowStart = Math.floor(resetMs / windowMs) * windowMs;
      const bucket = buckets.get(windowStart);
      if (bucket) bucket.push(entry);
      else buckets.set(windowStart, [entry]);
    }
  }

  const windows: ResumeWindow[] = [];

  if (dueEntries.length > 0) {
    dueEntries.sort(compareEntries);
    windows.push({
      windowStart: null,
      windowStartIso: null,
      opensInMs: 0,
      entries: dueEntries,
      count: dueEntries.length,
      due: true,
    });
  }

  for (const windowStart of [...buckets.keys()].sort((a, b) => a - b)) {
    const entries = buckets.get(windowStart) as ResumeAgendaEntry[];
    entries.sort(compareEntries);
    windows.push({
      windowStart,
      windowStartIso: new Date(windowStart).toISOString(),
      opensInMs: windowStart - now,
      entries,
      count: entries.length,
      due: false,
    });
  }

  let hiddenWindows = 0;
  let hiddenJobs = 0;
  let kept = windows;
  if (typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit >= 0) {
    const limit = Math.floor(options.limit);
    if (windows.length > limit) {
      kept = windows.slice(0, limit);
      const hidden = windows.slice(limit);
      hiddenWindows = hidden.length;
      hiddenJobs = hidden.reduce((sum, w) => sum + w.count, 0);
    }
  }

  return {
    now,
    windowMs,
    totalWaiting: waiting.length,
    dueNow: dueEntries.length,
    windows: kept,
    hiddenWindows,
    hiddenJobs,
  };
}
