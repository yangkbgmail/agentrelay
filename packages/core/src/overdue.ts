import type { RelayJob } from "./types.js";

/**
 * Why a job is flagged overdue — the two ways the relay can fall behind:
 *
 * - `reset-passed`: a `waiting_for_reset` job whose `resetAt` came due a while
 *   ago but that is still sitting in the queue. A healthy daemon resumes such a
 *   job almost immediately, so observing one long past due means the daemon
 *   isn't ticking (crashed, stopped, or never started).
 * - `stuck-resuming`: a job that entered `resuming` and never left. The daemon
 *   spawned the resume but the process (or the daemon) died before recording a
 *   terminal/waiting outcome, so the job is frozen mid-flight.
 */
export type OverdueReason = "reset-passed" | "stuck-resuming";

/**
 * One job the relay should have acted on by now but hasn't, plus how late it
 * is. Computed purely from the job list and an injected `now` (epoch ms) — no
 * clock, no queue, no I/O — so `agentrelay overdue` is unit-testable end to end.
 */
export interface OverdueEntry {
  /** The job that's overdue for action. */
  job: RelayJob;
  /** Why it's flagged (see {@link OverdueReason}). */
  reason: OverdueReason;
  /**
   * How long the relay has been late acting on this job, in ms (always ≥ 0).
   * For `reset-passed` that's `now − resetAt`; for `stuck-resuming` it's
   * `now − updatedAt` (how long it's been frozen in the `resuming` state).
   */
  lateByMs: number;
}

/**
 * The backward-looking health check: every job the relay should already have
 * moved on. Where `next`/`upcoming` look forward ("what resumes, and when?"),
 * `overdue` looks back ("what should have resumed but didn't?") — the fastest
 * way to notice a dead daemon or a wedged resume.
 */
export interface OverdueReport {
  /** Overdue jobs, most-overdue first. */
  entries: OverdueEntry[];
  /** Total overdue jobs (equals `entries.length`; convenience for callers). */
  total: number;
  /** Largest `lateByMs` across all entries; 0 when nothing is overdue. */
  worstLateByMs: number;
  /** Counts split by reason, so callers can headline "N late, M stuck". */
  byReason: { resetPassed: number; stuckResuming: number };
}

/** Tunables for {@link findOverdueJobs}; all optional with sensible defaults. */
export interface OverdueOptions {
  /**
   * A `waiting_for_reset` job counts as overdue only once it's past its reset by
   * more than this many ms. Defaults to 0 (any job past due). Raise it to absorb
   * normal daemon poll lag so `overdue` only surfaces jobs that are *genuinely*
   * late, not ones that came due this very instant.
   */
  graceMs?: number;
  /**
   * A `resuming` job counts as stuck once it's sat in that state, without any
   * update, for more than this many ms. `null`/`undefined` (the default)
   * disables the stuck-resuming check entirely, so `overdue` reports only
   * `reset-passed` jobs unless a threshold is supplied.
   */
  stuckResumingMs?: number | null;
}

/**
 * Order two overdue entries: most-overdue first, then oldest `createdAt`, then
 * id — fully deterministic even when two jobs are exactly as late.
 */
function compareOverdue(a: OverdueEntry, b: OverdueEntry): number {
  if (a.lateByMs !== b.lateByMs) return b.lateByMs - a.lateByMs;
  if (a.job.createdAt !== b.job.createdAt) return a.job.createdAt < b.job.createdAt ? -1 : 1;
  if (a.job.id === b.job.id) return 0;
  return a.job.id < b.job.id ? -1 : 1;
}

/**
 * Find every job the relay is late acting on. A `waiting_for_reset` job with a
 * parseable `resetAt` is `reset-passed` once `now − resetAt` exceeds `graceMs`;
 * a `resuming` job is `stuck-resuming` once `now − updatedAt` exceeds
 * `stuckResumingMs` (when that check is enabled). Both are surfaced with a
 * unified `lateByMs` so the report reads as one "how far behind is the relay?"
 * list. Returns an empty report when everything is on track.
 */
export function findOverdueJobs(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: OverdueOptions = {}
): OverdueReport {
  const graceMs = typeof options.graceMs === "number" && options.graceMs > 0 ? options.graceMs : 0;
  const stuckResumingMs =
    typeof options.stuckResumingMs === "number" && options.stuckResumingMs >= 0 ? options.stuckResumingMs : null;

  const entries: OverdueEntry[] = [];

  for (const job of jobs) {
    if (job.status === "waiting_for_reset" && job.resetAt !== null) {
      const resetMs = Date.parse(job.resetAt);
      if (Number.isNaN(resetMs)) continue;
      const lateByMs = now - resetMs;
      if (lateByMs > graceMs) {
        entries.push({ job, reason: "reset-passed", lateByMs });
      }
      continue;
    }

    if (job.status === "resuming" && stuckResumingMs !== null) {
      const updatedMs = Date.parse(job.updatedAt);
      if (Number.isNaN(updatedMs)) continue;
      const lateByMs = now - updatedMs;
      if (lateByMs > stuckResumingMs) {
        entries.push({ job, reason: "stuck-resuming", lateByMs });
      }
    }
  }

  entries.sort(compareOverdue);

  const byReason = {
    resetPassed: entries.filter((e) => e.reason === "reset-passed").length,
    stuckResuming: entries.filter((e) => e.reason === "stuck-resuming").length,
  };

  return {
    entries,
    total: entries.length,
    worstLateByMs: entries.length > 0 ? entries[0].lateByMs : 0,
    byReason,
  };
}
