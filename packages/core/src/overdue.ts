import type { RelayJob } from "./types.js";

/**
 * One `waiting_for_reset` job whose reset time has already passed by more than
 * the grace window — i.e. a scheduler tick *should* have resumed it by now but
 * apparently hasn't. Computed purely from the job list and an injected `now`
 * (epoch ms) — no clock, no queue, no I/O — so `agentrelay overdue` is
 * unit-testable end to end.
 */
export interface OverdueEntry {
  /** The stuck waiting job this row describes. */
  job: RelayJob;
  /** How long ago the reset time passed, in ms (always > graceMs). */
  overdueByMs: number;
}

/**
 * The set of resumes the relay has fallen behind on: `waiting_for_reset` jobs
 * whose `resetAt` is further in the past than `graceMs`. Where `upcoming` shows
 * the forward runway and `next` the single next move, `overdue` answers the
 * opposite, diagnostic question — "what should already be running but isn't?".
 * A non-empty report almost always means the resume loop (daemon/tick) is down,
 * or the agent binary can't spawn; a healthy relay keeps this empty.
 */
export interface OverdueReport {
  /** Overdue rows, most-overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** Total overdue jobs before any `limit` trim. */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The grace window applied, in ms (jobs due within it are not yet overdue). */
  graceMs: number;
  /** The worst single overdue span in ms (0 when nothing is overdue). */
  maxOverdueByMs: number;
}

/** Options for {@link buildOverdueReport}. */
export interface OverdueOptions {
  /**
   * Only flag jobs whose reset passed more than this many ms ago. Guards
   * against false alarms for jobs that just came due within a poll cycle or
   * two. Defaults to 0 (any past-due waiting job counts). Negative/non-finite
   * values are treated as 0.
   */
  graceMs?: number;
  /** Show at most this many entries; totals still count them all. */
  limit?: number;
}

/**
 * The epoch-ms instant since which the scheduler would treat a
 * `waiting_for_reset` job as due — the anchor for its overdue span — or `null`
 * when the job can't be placed on a timeline at all.
 *
 * For a parseable `resetAt` that's simply the reset instant. But an
 * **unparseable** (yet non-null) `resetAt` — a malformed date that can slip in
 * via a hand-edited store or a snapshot restored from before import validation
 * hardened — is treated by the queue's `isJobDue` as **due now**: the scheduler
 * *will* resume it. Such a job is therefore exactly the "should be running but
 * isn't" case `overdue` exists to surface, so we anchor its overdue span to when
 * it was parked (`updatedAt`, the transition into `waiting_for_reset`; falling
 * back to `createdAt`). Only a job whose timestamps are *all* unparseable — a
 * degenerate hand-edit the queue would never itself produce — returns `null` and
 * is left out, since there is no honest span to report.
 */
function overdueSinceMs(job: RelayJob): number | null {
  if (job.resetAt !== null) {
    const resetMs = Date.parse(job.resetAt);
    if (!Number.isNaN(resetMs)) return resetMs;
  }
  // Unparseable resetAt: isJobDue() treats it as due since it was parked.
  const updatedMs = Date.parse(job.updatedAt);
  if (!Number.isNaN(updatedMs)) return updatedMs;
  const createdMs = Date.parse(job.createdAt);
  if (!Number.isNaN(createdMs)) return createdMs;
  return null;
}

/**
 * Order two overdue jobs worst-first by their effective due instant: the one
 * that has been overdue longest comes first, then oldest `createdAt`, then id —
 * fully deterministic even when two jobs share a due time. Newest-overdue is the
 * tie-break's back, so the ranking surfaces the most-stuck job at the top where
 * it belongs.
 */
function compareOverdue(a: OverdueCandidate, b: OverdueCandidate): number {
  // Earlier due instant = longer overdue = should sort first.
  if (a.dueMs !== b.dueMs) return a.dueMs - b.dueMs;
  if (a.job.createdAt !== b.job.createdAt) return a.job.createdAt < b.job.createdAt ? -1 : 1;
  if (a.job.id === b.job.id) return 0;
  return a.job.id < b.job.id ? -1 : 1;
}

interface OverdueCandidate {
  job: RelayJob;
  /** The effective due instant (epoch ms) this job's overdue span is measured from. */
  dueMs: number;
}

/**
 * Build the overdue report: every `waiting_for_reset` job the scheduler would
 * treat as due (its reset already passed by more than `graceMs` — or its
 * `resetAt` is unparseable, which `isJobDue` surfaces as due-now), ranked
 * most-overdue first. This reads exactly the set the scheduler's `listDue` acts
 * on, so a populated report is a faithful "the daemon has these ready but isn't
 * running them" signal rather than a re-derivation of due logic.
 *
 * `limit` (a positive integer) trims the returned `entries`, but
 * `totalOverdue`/`maxOverdueByMs` still reflect the full set so callers can
 * honestly report "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: OverdueOptions = {}
): OverdueReport {
  const graceMs = Number.isFinite(options.graceMs) && (options.graceMs as number) > 0 ? (options.graceMs as number) : 0;

  const overdue: OverdueCandidate[] = [];
  for (const job of jobs) {
    if (job.status !== "waiting_for_reset" || job.resetAt === null) continue;
    const dueMs = overdueSinceMs(job);
    if (dueMs === null) continue;
    if (now - dueMs > graceMs) overdue.push({ job, dueMs });
  }
  overdue.sort(compareOverdue);

  const totalOverdue = overdue.length;
  const { limit } = options;
  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? overdue.slice(0, limit) : overdue;

  const entries: OverdueEntry[] = capped.map((c) => ({
    job: c.job,
    overdueByMs: now - c.dueMs,
  }));

  const maxOverdueByMs = totalOverdue > 0 ? now - overdue[0].dueMs : 0;

  return {
    entries,
    totalOverdue,
    hidden: totalOverdue - entries.length,
    graceMs,
    maxOverdueByMs,
  };
}
