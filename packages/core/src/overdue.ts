import type { RelayJob } from "./types.js";

/**
 * How long a job may sit past its reset time before `overdue` flags it. The
 * scheduler polls every 30s by default, so a job that came due only moments
 * ago is not stuck — a tick is about to pick it up. We wait ~3 poll intervals
 * (90s) before calling a job overdue, which keeps the "just became due" noise
 * out of the report while still catching a resume loop that has actually
 * stalled (dead daemon, missing agent binary, un-writable store).
 */
export const DEFAULT_OVERDUE_GRACE_MS = 90_000;

/**
 * One job whose reset time has passed by more than the grace window and yet is
 * still `waiting_for_reset` — i.e. the relay should have resumed it already but
 * hasn't. Computed purely from the job list and an injected `now` (epoch ms) so
 * `agentrelay overdue` is unit-testable without a clock, queue, or process.
 */
export interface OverdueEntry {
  /** The waiting job that is past due. */
  job: RelayJob;
  /** Milliseconds `now` is past the job's reset time (always > graceMs). */
  overdueByMs: number;
  /** 1-based position in the report, most overdue first (1 = worst offender). */
  position: number;
}

/**
 * The backward-looking counterpart to `upcoming`: jobs the relay was supposed
 * to have resumed by now. Where `upcoming` shows the runway ahead, `overdue`
 * surfaces the symptom of a stuck resume loop — a daemon can report a fresh
 * heartbeat (so `health`/`doctor` look fine) and still fail to resume a
 * specific job because its binary is missing or the store isn't writable.
 * `overdue` catches exactly that gap.
 */
export interface OverdueReport {
  /** Overdue rows, most overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** How many jobs are overdue in total (before any `limit` trim). */
  totalOverdue: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The single worst overdue span in ms (0 when nothing is overdue). */
  maxOverdueByMs: number;
  /** The grace window (ms) used to decide what counts as overdue. */
  graceMs: number;
}

/**
 * Order two overdue jobs worst-first: the one that has waited longest past its
 * reset comes first, then oldest `createdAt`, then id — fully deterministic
 * even when two jobs share a reset time.
 */
function compareOverdue(a: RelayJob, b: RelayJob): number {
  const ra = Date.parse(a.resetAt as string);
  const rb = Date.parse(b.resetAt as string);
  // Earlier reset time → more overdue → sorts first.
  if (ra !== rb) return ra - rb;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the overdue report: every `waiting_for_reset` job whose parseable
 * `resetAt` is more than `graceMs` in the past, sorted worst-first. These are
 * the jobs a healthy scheduler would already have moved on, so a non-empty
 * report is a strong signal the resume loop is not doing its job.
 *
 * `graceMs` (default {@link DEFAULT_OVERDUE_GRACE_MS}) is clamped to >= 0 so a
 * negative value can't silently flag every due-now job. `limit` (when a
 * positive integer) trims `entries` to the worst N, but `totalOverdue`/
 * `maxOverdueByMs` still reflect the full set so callers can honestly report
 * "N more not shown".
 */
export function findOverdueJobs(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: { graceMs?: number; limit?: number } = {}
): OverdueReport {
  const graceMs =
    typeof options.graceMs === "number" && options.graceMs >= 0 ? options.graceMs : DEFAULT_OVERDUE_GRACE_MS;
  const threshold = now - graceMs;

  const overdue = jobs
    .filter((job) => {
      if (job.status !== "waiting_for_reset" || job.resetAt === null) return false;
      const resetMs = Date.parse(job.resetAt);
      return !Number.isNaN(resetMs) && resetMs < threshold;
    })
    .sort(compareOverdue);

  const totalOverdue = overdue.length;
  const maxOverdueByMs = totalOverdue === 0 ? 0 : now - Date.parse(overdue[0].resetAt as string);

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
    maxOverdueByMs,
    graceMs,
  };
}
