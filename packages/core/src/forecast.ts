import { normalizeMaxConcurrent } from "./concurrency.js";
import type { RelayJob } from "./types.js";

/**
 * Capacity-aware queue-drain forecast.
 *
 * Where {@link computeQueueEta} answers "when does the *last* reset happen", it
 * deliberately stops at that moment — it treats every waiting job as resuming
 * instantly and for free. In reality each resume spawns a full agent CLI run
 * that takes real wall-clock time, and the scheduler only runs
 * `AGENTRELAY_MAX_CONCURRENT` of them at once (see {@link mapWithConcurrency}).
 * So when a "resume herd" comes due together — every job in a project the
 * instant its window reopens — draining the backlog can take meaningfully
 * *longer* than the last reset: the jobs queue up behind the concurrency bound.
 *
 * `computeQueueForecast` models exactly that. Given the waiting jobs, a
 * concurrency limit `K`, and an estimated per-resume duration `D`, it runs a
 * tiny deterministic discrete-event simulation over `K` slots and reports when
 * the queue is actually *drained* (the last resume finishes), not merely when
 * the last window reopens. Pure — no clock, no queue, no I/O (an explicit `now`
 * is injected) — so `agentrelay forecast` is unit-testable end to end.
 */
export interface JobForecast {
  /** Full job id. */
  jobId: string;
  /** Project the job belongs to. */
  project: string;
  /** The reset that gates this job (ISO). */
  resetAt: string;
  /** now → when the job becomes eligible: `max(resetAt, now) - now` (≥ 0). */
  readyMs: number;
  /** now → when a slot frees and the resume actually starts (≥ `readyMs`). */
  startMs: number;
  /** now → when the resume finishes: `startMs + jobDurationMs`. */
  finishMs: number;
  /** Which concurrency slot (0 … K-1) ran this resume. */
  slot: number;
  /**
   * `startMs - readyMs` — how long the job sat eligible-but-waiting because
   * every slot was busy. Zero when a slot was free the moment it came due;
   * positive only under contention at the concurrency bound.
   */
  queuedMs: number;
}

/**
 * The whole-queue drain forecast: per-job timeline plus the headline numbers a
 * caller needs to decide "how long until the relay has truly finished draining
 * this backlog, given how many resumes run at once?".
 */
export interface QueueForecast {
  /** Number of `waiting_for_reset` jobs with a parseable `resetAt`. */
  waiting: number;
  /** Concurrency limit the simulation used (normalized ≥ 1). */
  maxConcurrent: number;
  /** Per-resume duration (ms) the simulation used. */
  jobDurationMs: number;
  /** Per-job rows, ordered by when each resume finishes (soonest first). */
  entries: JobForecast[];
  /** Soonest reset among the waiting jobs (ISO), or null when none wait. */
  firstResetAt: string | null;
  /** Latest reset among the waiting jobs (ISO), or null when none wait. */
  lastResetAt: string | null;
  /**
   * now → when the *last* resume finishes — the queue is fully drained. Null
   * when nothing waits. Can exceed `naiveEtaMs` (contention) but never precede
   * `lastResetAt + jobDurationMs`.
   */
  drainMs: number | null;
  /** Absolute drain moment (ISO), or null when nothing waits. */
  drainAt: string | null;
  /**
   * now → `lastResetAt`: the naive ETA that {@link computeQueueEta} reports,
   * which ignores resume duration and the concurrency bound. Kept here so a
   * caller can show the gap. Null when nothing waits.
   */
  naiveEtaMs: number | null;
  /**
   * Extra wall-clock the drain costs *beyond* the unavoidable
   * `max(naiveEta, 0) + jobDurationMs` (last window reopening, then one resume
   * running): `drainMs - (max(naiveEtaMs, 0) + jobDurationMs)`, clamped to ≥ 0.
   * This isolates the penalty caused purely by jobs queuing behind the
   * concurrency bound — zero when `K` is large enough that nothing ever waits
   * for a slot, positive when a herd serializes. Null when nothing waits.
   */
  contentionMs: number | null;
  /** Worst per-job `queuedMs` across the run (0 when nothing contends). */
  maxQueuedMs: number;
  /** True when no job is waiting for a reset — the relay has nothing pending. */
  caughtUp: boolean;
}

/** A waiting job paired with its parsed reset time (epoch ms), for simulation. */
interface Waiting {
  job: RelayJob;
  resetMs: number;
}

/**
 * Collect the same set the scheduler's `listDue` acts on — `waiting_for_reset`
 * jobs with a parseable `resetAt` — and order them by which the scheduler will
 * pick up first: earliest reset, then oldest `createdAt`, then id. Matching
 * `next`/`upcoming`/`eta`'s filter and `next`'s tie-break keeps every surface
 * agreeing on "what the relay is actually waiting on, and in what order".
 */
function waitingInResumeOrder(jobs: RelayJob[]): Waiting[] {
  const waiting: Waiting[] = [];
  for (const job of jobs) {
    if (job.status !== "waiting_for_reset" || job.resetAt === null) continue;
    const resetMs = Date.parse(job.resetAt);
    if (Number.isNaN(resetMs)) continue;
    waiting.push({ job, resetMs });
  }
  waiting.sort((a, b) => {
    if (a.resetMs !== b.resetMs) return a.resetMs - b.resetMs;
    if (a.job.createdAt !== b.job.createdAt) return a.job.createdAt < b.job.createdAt ? -1 : 1;
    if (a.job.id === b.job.id) return 0;
    return a.job.id < b.job.id ? -1 : 1;
  });
  return waiting;
}

/**
 * Normalize a requested per-resume duration to a non-negative integer of
 * milliseconds. Anything unusable (undefined, NaN, Infinity, negative) falls
 * back to `fallback` so a bad estimate never makes the forecast collapse to a
 * zero-cost or NaN drain. Fractional values floor.
 */
export function normalizeJobDurationMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return Math.max(0, Math.floor(fallback));
  return Math.floor(value);
}

/**
 * Run the drain simulation. `K` slots each track the epoch-ms moment they next
 * come free (all start at `now`). Jobs are released at `max(resetAt, now)`; each
 * is assigned to the slot that frees earliest (lowest index on ties, for
 * determinism), starting at `max(release, slotFree)` and finishing one duration
 * later. The last finish is when the queue is drained.
 *
 * Returns a `caughtUp` report (all-null headline fields) when nothing is waiting
 * for a reset — an empty queue, or only active/terminal jobs.
 */
export function computeQueueForecast(
  jobs: RelayJob[],
  options: { now?: number; maxConcurrent?: number; jobDurationMs?: number } = {}
): QueueForecast {
  const now = options.now ?? Date.now();
  const maxConcurrent = normalizeMaxConcurrent(options.maxConcurrent);
  const jobDurationMs = normalizeJobDurationMs(options.jobDurationMs, 0);

  const waiting = waitingInResumeOrder(jobs);
  if (waiting.length === 0) {
    return {
      waiting: 0,
      maxConcurrent,
      jobDurationMs,
      entries: [],
      firstResetAt: null,
      lastResetAt: null,
      drainMs: null,
      drainAt: null,
      naiveEtaMs: null,
      contentionMs: null,
      maxQueuedMs: 0,
      caughtUp: true,
    };
  }

  const firstResetMs = waiting[0].resetMs;
  let lastResetMs = waiting[0].resetMs;
  for (const w of waiting) if (w.resetMs > lastResetMs) lastResetMs = w.resetMs;

  // One "free at" clock per concurrency slot, all initially idle at `now`.
  const slotFreeAt = new Array<number>(maxConcurrent).fill(now);

  const entries: JobForecast[] = [];
  let drainAbs = now;
  let maxQueuedMs = 0;

  for (const { job, resetMs } of waiting) {
    const readyAbs = Math.max(resetMs, now);

    // Earliest-free slot (lowest index breaks ties → deterministic).
    let slot = 0;
    for (let s = 1; s < slotFreeAt.length; s++) {
      if (slotFreeAt[s] < slotFreeAt[slot]) slot = s;
    }

    const startAbs = Math.max(readyAbs, slotFreeAt[slot]);
    const finishAbs = startAbs + jobDurationMs;
    slotFreeAt[slot] = finishAbs;
    if (finishAbs > drainAbs) drainAbs = finishAbs;

    const queuedMs = startAbs - readyAbs;
    if (queuedMs > maxQueuedMs) maxQueuedMs = queuedMs;

    entries.push({
      jobId: job.id,
      project: job.project,
      resetAt: job.resetAt as string,
      readyMs: readyAbs - now,
      startMs: startAbs - now,
      finishMs: finishAbs - now,
      slot,
      queuedMs,
    });
  }

  // Present the timeline in drain order (soonest finish first), tie-broken by
  // start then id so the ordering is stable and reproducible.
  entries.sort((a, b) => {
    if (a.finishMs !== b.finishMs) return a.finishMs - b.finishMs;
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
  });

  const drainMs = drainAbs - now;
  const naiveEtaMs = lastResetMs - now;
  const unavoidableMs = Math.max(naiveEtaMs, 0) + jobDurationMs;
  const contentionMs = Math.max(0, drainMs - unavoidableMs);

  return {
    waiting: waiting.length,
    maxConcurrent,
    jobDurationMs,
    entries,
    firstResetAt: new Date(firstResetMs).toISOString(),
    lastResetAt: new Date(lastResetMs).toISOString(),
    drainMs,
    drainAt: new Date(drainAbs).toISOString(),
    naiveEtaMs,
    contentionMs,
    maxQueuedMs,
    caughtUp: false,
  };
}
