import type { RelayJob } from "./types.js";

/**
 * One job whose reset time has already passed but that is still
 * `waiting_for_reset` — the scheduler should have resumed it by now. Computed
 * purely from the job list and an injected `now` (epoch ms) — no clock, no
 * queue, no I/O — so `agentrelay overdue` is unit-testable end to end.
 */
export interface OverdueEntry {
  /** The overdue waiting job this row describes. */
  job: RelayJob;
  /** How long the reset time is already past, in ms. Always > graceMs (larger = more overdue). */
  overdueMs: number;
  /** 1-based rank in the report (1 = the most overdue job). */
  position: number;
}

/**
 * The backlog of resumes the relay has fallen behind on: every
 * `waiting_for_reset` job whose `resetAt` passed more than `graceMs` ago,
 * ranked most-overdue first. Where `upcoming` looks forward ("what resumes
 * next, and when?"), `overdue` looks backward ("what should have resumed
 * already but hasn't?"). A short, stable overdue list is normal (jobs come due
 * a tick before the daemon picks them up); a growing list, or one where the
 * worst lag keeps climbing, means the resume loop is stalled — the per-job
 * complement to `health`'s heartbeat probe.
 */
export interface OverdueReport {
  /** Overdue rows, most-overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue beyond the grace period in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The grace period (ms) applied: a job counts as overdue only once past by more than this. */
  graceMs: number;
  /** The most overdue job's lag in ms, or 0 when nothing is overdue. */
  worstOverdueMs: number;
}

/**
 * Order two overdue jobs by how far behind they are: earliest reset time wins
 * (most overdue first), then oldest `createdAt`, then id — so the ranking is
 * fully deterministic even when two jobs share a reset time. This reuses the
 * same tie-break as `next`/`upcoming` (which order soonest-first); here the
 * jobs are all in the past, so earliest-reset-first surfaces the longest lag.
 */
function compareOverdue(a: RelayJob, b: RelayJob): number {
  const ra = Date.parse(a.resetAt as string);
  const rb = Date.parse(b.resetAt as string);
  if (ra !== rb) return ra - rb;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the overdue-resume report: the `waiting_for_reset` jobs with a
 * parseable `resetAt` that passed more than `graceMs` ago, ranked most-overdue
 * first. This reads exactly the set the scheduler's `listDue` would act on, so
 * a job appearing here means "due, but not yet resumed".
 *
 * `graceMs` (default 0) filters out jobs that only just came due — set it to a
 * few minutes so a job that came due one tick ago (normal, transient) doesn't
 * register as a problem, while one stuck for longer (a stalled loop) does.
 *
 * `limit` (when a non-negative integer) trims the returned `entries` to the N
 * most overdue, but `totalOverdue`/`worstOverdueMs` still reflect the full set
 * so callers can honestly report "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: { graceMs?: number; limit?: number } = {}
): OverdueReport {
  const graceMs = typeof options.graceMs === "number" && options.graceMs > 0 ? options.graceMs : 0;
  const threshold = now - graceMs;

  const overdue = jobs
    .filter(
      (job) =>
        job.status === "waiting_for_reset" &&
        job.resetAt !== null &&
        !Number.isNaN(Date.parse(job.resetAt)) &&
        Date.parse(job.resetAt) <= threshold
    )
    .sort(compareOverdue);

  const totalOverdue = overdue.length;
  const worstOverdueMs = totalOverdue > 0 ? now - Date.parse(overdue[0].resetAt as string) : 0;

  const { limit } = options;
  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? overdue.slice(0, limit) : overdue;

  const entries: OverdueEntry[] = capped.map((job, index) => ({
    job,
    overdueMs: now - Date.parse(job.resetAt as string),
    position: index + 1,
  }));

  return {
    entries,
    totalOverdue,
    hidden: totalOverdue - entries.length,
    graceMs,
    worstOverdueMs,
  };
}
