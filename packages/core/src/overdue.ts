import type { RelayJob } from "./types.js";

/**
 * A job whose reset time has already elapsed but that is still parked in
 * `waiting_for_reset` — i.e. the scheduler *should* have resumed it by now but
 * hasn't. `overdueMs` is how long past its reset time it has been sitting.
 */
export interface OverdueJob {
  job: RelayJob;
  /** Milliseconds since the job's reset time passed (always > graceMs, > 0). */
  overdueMs: number;
}

/**
 * The result of {@link computeOverdue}: how many jobs are waiting for a reset,
 * how many of those are past due beyond the grace window, and the overdue jobs
 * themselves (most overdue first).
 */
export interface OverdueReport {
  /** Jobs in `waiting_for_reset` with a parseable `resetAt` (the candidate set). */
  totalWaiting: number;
  /** How many of those are overdue beyond `graceMs` ({@link jobs}.length). */
  overdueCount: number;
  /** The grace window (ms) a reset may sit past-due before counting as overdue. */
  graceMs: number;
  /** Overdue jobs, ranked by how long they've been late (desc), ties broken deterministically. */
  jobs: OverdueJob[];
}

/**
 * Order two overdue jobs so the one that has been late longest comes first,
 * with `createdAt` then `id` as deterministic tie-breakers (mirrors the
 * ordering used by `next`/`stats` so output is stable across runs).
 */
function compareOverdue(a: OverdueJob, b: OverdueJob): number {
  if (a.overdueMs !== b.overdueMs) return b.overdueMs - a.overdueMs;
  if (a.job.createdAt !== b.job.createdAt) return a.job.createdAt < b.job.createdAt ? -1 : 1;
  if (a.job.id === b.job.id) return 0;
  return a.job.id < b.job.id ? -1 : 1;
}

/**
 * Find jobs the relay was supposed to resume but hasn't: those still in
 * `waiting_for_reset` whose `resetAt` passed more than `graceMs` ago. This is
 * the single clearest signal that the relay isn't doing its job — the reset
 * window opened, yet nothing picked the job up. A healthy daemon clears a
 * due job within a poll interval, so `graceMs` lets callers ignore the brief,
 * expected window between "due" and "resumed" and only flag genuinely stuck jobs.
 *
 * Pure: computed from the job list and an injected `now` (epoch ms) — no clock,
 * no queue, no I/O — so `agentrelay overdue` is unit-testable end to end. Only
 * `waiting_for_reset` jobs count (mirroring the scheduler's due set); active
 * `resuming` jobs are mid-flight, `queued` jobs have no reset yet, and terminal
 * jobs are done. Jobs with a null or unparseable `resetAt` can't be placed on a
 * timeline and are excluded.
 */
export function computeOverdue(jobs: RelayJob[], options: { now?: number; graceMs?: number } = {}): OverdueReport {
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs !== undefined && options.graceMs > 0 ? options.graceMs : 0;

  let totalWaiting = 0;
  const overdue: OverdueJob[] = [];

  for (const job of jobs) {
    if (job.status !== "waiting_for_reset" || job.resetAt === null) continue;
    const resetMs = Date.parse(job.resetAt);
    if (Number.isNaN(resetMs)) continue;
    totalWaiting += 1;

    const overdueMs = now - resetMs;
    if (overdueMs > graceMs) overdue.push({ job, overdueMs });
  }

  overdue.sort(compareOverdue);

  return { totalWaiting, overdueCount: overdue.length, graceMs, jobs: overdue };
}
