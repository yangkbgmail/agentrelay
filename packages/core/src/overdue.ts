import type { RelayJob } from "./types.js";

/**
 * How long past its `resetAt` a waiting job may sit before we call it overdue.
 * A live daemon polls on an interval and a resume can't be instantaneous, so a
 * job being a few seconds past due is normal, not a fault. The default grace of
 * two minutes comfortably clears a typical poll interval while still flagging
 * the failure this command exists to catch: a job whose reset came and went but
 * that nothing ever resumed (dead/stuck daemon, missing binary, unwritable
 * store). Callers can widen or narrow it via `graceMs`.
 */
export const DEFAULT_OVERDUE_GRACE_MS = 2 * 60 * 1000;

/**
 * One waiting job whose reset time has passed by more than the grace period,
 * plus the context the CLI needs to render it. Computed purely from the job
 * list and an injected `now` (epoch ms) — no clock, no queue, no I/O — so
 * `agentrelay overdue` is unit-testable end to end.
 */
export interface OverdueEntry {
  /** The overdue job this row describes. */
  job: RelayJob;
  /** Milliseconds since its reset time passed (always > graceMs, so > 0). */
  overdueByMs: number;
  /** 1-based position, most overdue first (1 = worst). */
  position: number;
}

/**
 * The set of `waiting_for_reset` jobs the relay should already have resumed but
 * hasn't. Where `upcoming` shows the forward runway (what resumes next and
 * when), `overdue` looks backward: jobs whose moment came and went. A non-empty
 * report is a strong signal the resume loop isn't running — the job-centric
 * counterpart to `doctor`'s heartbeat check.
 */
export interface OverdueReport {
  /** Overdue rows, most overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The grace period used, echoed so callers/JSON can report the threshold. */
  graceMs: number;
}

/**
 * Order two overdue jobs worst-first: the one whose reset passed longest ago
 * comes first, then oldest `createdAt`, then id — fully deterministic even when
 * two jobs are overdue by the same amount.
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
 * Build the overdue report: `waiting_for_reset` jobs with a parseable `resetAt`
 * that passed more than `graceMs` before `now`, sorted worst-first. This is the
 * subset of `upcoming`'s "due now" rows that have stayed stuck past the grace
 * window — i.e. resumes that should have happened but didn't.
 *
 * `graceMs` defaults to {@link DEFAULT_OVERDUE_GRACE_MS}; a negative value is
 * floored to 0 (any past-due job counts). `limit` (when a non-negative integer)
 * trims the returned `entries` to the worst N, but `totalOverdue` still reflects
 * the full set so callers can honestly report "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: { graceMs?: number; limit?: number } = {}
): OverdueReport {
  const graceMs = Math.max(0, options.graceMs ?? DEFAULT_OVERDUE_GRACE_MS);
  const cutoff = now - graceMs;

  const overdue = jobs
    .filter(
      (job) =>
        job.status === "waiting_for_reset" &&
        job.resetAt !== null &&
        !Number.isNaN(Date.parse(job.resetAt)) &&
        Date.parse(job.resetAt) < cutoff
    )
    .sort(compareOverdue);

  const totalOverdue = overdue.length;
  const { limit } = options;
  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? overdue.slice(0, limit) : overdue;

  const entries: OverdueEntry[] = capped.map((job, index) => ({
    job,
    overdueByMs: now - Date.parse(job.resetAt as string),
    position: index + 1,
  }));

  return {
    entries,
    totalOverdue,
    hidden: totalOverdue - entries.length,
    graceMs,
  };
}
