import type { RelayJob } from "./types.js";

/**
 * Why a job counts as "overdue". Two distinct failure modes the relay loop can
 * fall into, and the one thing they share — the wall clock has moved well past
 * the point where a healthy daemon should have acted:
 *
 * - `waiting`  — a `waiting_for_reset` job whose `resetAt` passed more than the
 *   grace window ago. A running daemon would have moved it to `resuming` by
 *   now; it's still parked, so either no daemon is running or it's stalled.
 * - `resuming` — a job that entered `resuming` and has sat there, untouched,
 *   longer than the stale window. A resume that started but never finished —
 *   typically a daemon that died mid-resume — leaves a job stranded in this
 *   state where neither `next` nor `upcoming` will ever surface it again.
 */
export type OverdueKind = "waiting" | "resuming";

/**
 * One overdue job plus the context the CLI needs to explain *why* it's flagged.
 * Computed purely from the job list and an injected `now` (epoch ms) — no clock,
 * no queue, no I/O — so `agentrelay overdue` is unit-testable end to end.
 */
export interface OverdueEntry {
  /** The overdue job this row describes. */
  job: RelayJob;
  /** Which failure mode flagged it (see {@link OverdueKind}). */
  kind: OverdueKind;
  /**
   * Milliseconds by which the job is late: `now` minus the reference timestamp
   * (`resetAt` for `waiting`, `updatedAt` for `resuming`). Always strictly
   * greater than the relevant threshold, since that's the flag condition.
   */
  overdueByMs: number;
  /**
   * The timestamp the lateness was measured against — the job's `resetAt`
   * (`waiting`) or `updatedAt` (`resuming`) — echoed so callers don't have to
   * re-derive which field drove the flag.
   */
  referenceAt: string;
}

/**
 * The set of jobs the relay should have acted on but hasn't. Where `next` and
 * `upcoming` look *forward* ("what resumes, and when"), `overdue` looks at what
 * is already *late* — the primary signal that the daemon is stopped, stuck, or
 * lagging. An empty report is the healthy case.
 */
export interface OverdueReport {
  /** Overdue rows, most-overdue first. */
  entries: OverdueEntry[];
  /** How many `waiting` (parked-past-reset) jobs are overdue. */
  waitingCount: number;
  /** How many `resuming` (stuck mid-resume) jobs are overdue. */
  resumingCount: number;
  /** Total overdue jobs (`waitingCount + resumingCount`). */
  total: number;
  /** The grace window (ms) applied to `waiting_for_reset` jobs. */
  graceMs: number;
  /** The stale window (ms) applied to `resuming` jobs. */
  staleMs: number;
}

/** Default grace after `resetAt` before a parked job is called overdue: 1 minute. */
export const DEFAULT_OVERDUE_GRACE_MS = 60_000;

/** Default time a job may sit in `resuming` before it's called stuck: 5 minutes. */
export const DEFAULT_RESUMING_STALE_MS = 300_000;

/** Options for {@link buildOverdueReport}; both thresholds default when omitted. */
export interface OverdueOptions {
  /**
   * How long past `resetAt` a `waiting_for_reset` job may linger before it's
   * flagged. Absorbs the daemon's poll interval and small clock skew so a job
   * that's due "right now" isn't reported as a problem. Defaults to
   * {@link DEFAULT_OVERDUE_GRACE_MS}.
   */
  graceMs?: number;
  /**
   * How long a job may sit in `resuming` (measured from `updatedAt`) before
   * it's flagged as stuck. Defaults to {@link DEFAULT_RESUMING_STALE_MS}.
   */
  staleMs?: number;
}

/**
 * Order two overdue entries worst-first: the most-overdue job leads, then
 * oldest `createdAt`, then id — fully deterministic even when two jobs are
 * equally late.
 */
function compareOverdue(a: OverdueEntry, b: OverdueEntry): number {
  if (a.overdueByMs !== b.overdueByMs) return b.overdueByMs - a.overdueByMs;
  if (a.job.createdAt !== b.job.createdAt) return a.job.createdAt < b.job.createdAt ? -1 : 1;
  if (a.job.id === b.job.id) return 0;
  return a.job.id < b.job.id ? -1 : 1;
}

/**
 * Build the overdue report: the jobs a healthy daemon should already have
 * moved on. A `waiting_for_reset` job is overdue when its parseable `resetAt`
 * is older than `now - graceMs`; a `resuming` job is overdue when its
 * parseable `updatedAt` is older than `now - staleMs`. Jobs with an unparseable
 * timestamp are skipped (they can't be reasoned about), and terminal/queued
 * jobs are never overdue by definition. Entries come back worst-first.
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: OverdueOptions = {}
): OverdueReport {
  const graceMs = options.graceMs ?? DEFAULT_OVERDUE_GRACE_MS;
  const staleMs = options.staleMs ?? DEFAULT_RESUMING_STALE_MS;

  const entries: OverdueEntry[] = [];

  for (const job of jobs) {
    if (job.status === "waiting_for_reset") {
      if (job.resetAt === null) continue;
      const resetMs = Date.parse(job.resetAt);
      if (Number.isNaN(resetMs)) continue;
      const overdueByMs = now - resetMs;
      if (overdueByMs > graceMs) {
        entries.push({ job, kind: "waiting", overdueByMs, referenceAt: job.resetAt });
      }
    } else if (job.status === "resuming") {
      const updatedMs = Date.parse(job.updatedAt);
      if (Number.isNaN(updatedMs)) continue;
      const overdueByMs = now - updatedMs;
      if (overdueByMs > staleMs) {
        entries.push({ job, kind: "resuming", overdueByMs, referenceAt: job.updatedAt });
      }
    }
  }

  entries.sort(compareOverdue);

  const waitingCount = entries.filter((e) => e.kind === "waiting").length;
  const resumingCount = entries.length - waitingCount;

  return {
    entries,
    waitingCount,
    resumingCount,
    total: entries.length,
    graceMs,
    staleMs,
  };
}
