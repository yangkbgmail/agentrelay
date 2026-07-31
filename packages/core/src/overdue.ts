import type { RelayJob } from "./types.js";

/**
 * Default grace window (ms) before an overdue job is flagged as *concerning*.
 * A scheduler tick only fires every poll interval, so a job that came due a few
 * seconds ago is perfectly normal — the daemon simply hasn't ticked yet. Only
 * once a job has sat past its reset for longer than any sane poll interval does
 * "overdue" mean "something is probably wrong" (the resume loop is down,
 * wedged, or looking at a different store). One minute is comfortably above the
 * default fast-poll cadence while still catching a genuinely stuck relay fast.
 */
export const DEFAULT_OVERDUE_GRACE_MS = 60_000;

/**
 * One overdue job: a `waiting_for_reset` job whose reset time has already
 * passed but which is still sitting in the queue unresumed. Computed purely
 * from the job list and an injected `now` (epoch ms) — no clock, no queue, no
 * I/O — so `agentrelay overdue` is unit-testable end to end.
 */
export interface OverdueEntry {
  /** The waiting job whose reset time has passed. */
  job: RelayJob;
  /** How long ago the reset time passed, in ms (always ≥ 0). */
  overdueByMs: number;
  /**
   * True once the job has been overdue longer than the grace window — i.e. long
   * enough that a healthy relay should already have resumed it. This is the
   * signal worth alerting on; a freshly-due job (within grace) is not.
   */
  concerning: boolean;
  /** 1-based position in the report, most overdue first (1 = worst offender). */
  position: number;
}

/**
 * The set of jobs the relay was supposed to have resumed by now but hasn't.
 * Where `next`/`upcoming` look forward ("what resumes next, and when?"),
 * `overdue` looks backward ("what should already be running but isn't?") — the
 * clearest single view of the silent-resume-failure this whole tool exists to
 * prevent.
 */
export interface OverdueReport {
  /** Overdue rows, most overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** Every `waiting_for_reset` job with a parseable reset time (the denominator). */
  totalWaiting: number;
  /** How many waiting jobs are past their reset (before any grace or `limit`). */
  overdueCount: number;
  /** How many overdue jobs are past the grace window — the ones worth alerting on. */
  concerningCount: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The grace window (ms) used to decide `concerning`. */
  graceMs: number;
  /** The largest `overdueByMs` in the report, or null when nothing is overdue. */
  worstOverdueMs: number | null;
}

/**
 * Order two overdue jobs worst-first: the one that came due earliest (most
 * overdue) leads, then oldest `createdAt`, then id — so the ordering is fully
 * deterministic even when two jobs share a reset time. The tie-break matches
 * `next`/`upcoming` exactly, just with the primary key inverted (most overdue
 * rather than soonest due).
 */
function compareOverdue(a: RelayJob, b: RelayJob): number {
  const ra = Date.parse(a.resetAt as string);
  const rb = Date.parse(b.resetAt as string);
  if (ra !== rb) return ra - rb; // earlier reset = more overdue = first
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the overdue report: the `waiting_for_reset` jobs whose parseable
 * `resetAt` is at or before `now`, sorted most-overdue first. This mirrors the
 * exact set the scheduler's due logic acts on, so a job showing up here is one
 * the daemon *should* have picked up already — if it hasn't, the resume loop is
 * behind (or not running at all).
 *
 * `graceMs` (default {@link DEFAULT_OVERDUE_GRACE_MS}) sets how long a job may
 * be overdue before it counts as `concerning`; negative/non-finite values clamp
 * to 0. `limit` (a positive integer) trims the returned `entries` to the worst
 * N, but `totalWaiting`/`overdueCount`/`concerningCount` still reflect the full
 * set so callers can honestly report "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: { graceMs?: number; limit?: number } = {}
): OverdueReport {
  const requestedGrace = options.graceMs === undefined ? DEFAULT_OVERDUE_GRACE_MS : options.graceMs;
  const graceMs = Number.isFinite(requestedGrace) && requestedGrace > 0 ? requestedGrace : 0;

  const waiting = jobs.filter(
    (job) => job.status === "waiting_for_reset" && job.resetAt !== null && !Number.isNaN(Date.parse(job.resetAt))
  );

  const overdue = waiting.filter((job) => Date.parse(job.resetAt as string) <= now).sort(compareOverdue);

  const overdueCount = overdue.length;
  const worstOverdueMs = overdueCount === 0 ? null : now - Date.parse(overdue[0].resetAt as string);
  const concerningCount = overdue.filter((job) => now - Date.parse(job.resetAt as string) > graceMs).length;

  const { limit } = options;
  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? overdue.slice(0, limit) : overdue;

  const entries: OverdueEntry[] = capped.map((job, index) => {
    const overdueByMs = now - Date.parse(job.resetAt as string);
    return {
      job,
      overdueByMs,
      concerning: overdueByMs > graceMs,
      position: index + 1,
    };
  });

  return {
    entries,
    totalWaiting: waiting.length,
    overdueCount,
    concerningCount,
    hidden: overdueCount - entries.length,
    graceMs,
    worstOverdueMs,
  };
}
