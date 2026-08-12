import type { RelayJob } from "./types.js";

/**
 * Attempt-count distribution for `agentrelay attempts`. `stats` already reports
 * `totalAttempts` (a sum) and `retriedJobs` (a `attempts > 1` count), but neither
 * shows the *shape* of the retry effort: how many jobs sailed through on a single
 * resume versus how many the relay had to nurse through many resume cycles. This
 * fills that gap with a histogram keyed on each job's `attempts` value.
 *
 * `attempts` accumulates monotonically over a job's lifetime — every resume bumps
 * it by one (see `RelayQueue.markResuming`), and neither a repeat rate-limit
 * (`markWaitingForReset`) nor a transient-failure backoff (`markRetryScheduled`)
 * resets it. Only a user-initiated `agentrelay retry` (`requeueNow`) zeroes it. So
 * a job's `attempts` is a faithful count of how many resume cycles the relay ran
 * for it: 0 = enqueued but not yet resumed, 1 = resumed once, N = N resume cycles.
 */
export interface AttemptBucket {
  /** The attempt count these jobs share (0, 1, 2, …). */
  attempts: number;
  /** Number of jobs with exactly this attempt count. */
  count: number;
}

/**
 * Fleet-wide attempt distribution: totals plus one bucket per distinct attempt
 * count, ordered ascending so it reads as a natural histogram (0, 1, 2, …).
 */
export interface AttemptDistribution {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Sum of `attempts` across all jobs — matches `stats.totalAttempts`. */
  totalAttempts: number;
  /** Jobs resumed more than once (`attempts > 1`) — matches `stats.retriedJobs`. */
  retriedJobs: number;
  /** Jobs never resumed yet (`attempts === 0`): freshly queued / awaiting first reset. */
  neverResumed: number;
  /** The highest attempt count seen, or 0 when there are no jobs. */
  maxAttempts: number;
  /** Mean attempts per job (`totalAttempts / total`), or null when there are no jobs. */
  meanAttempts: number | null;
  /** One row per distinct attempt count, ascending by `attempts`. */
  buckets: AttemptBucket[];
}

/**
 * Coerce a job's `attempts` to a non-negative integer bucket key. The type is
 * already `number`, but a corrupt/hand-edited store could carry a negative,
 * fractional, or non-finite value; rather than throw or skew the totals, we clamp
 * to a sane integer so the histogram stays robust (mirrors the defensive style of
 * the other pure summarizers).
 */
function attemptKey(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

/**
 * Buckets a job list by attempt count into a histogram for `agentrelay attempts`.
 * Pure and non-mutating: no I/O, no ambient clock. Buckets are ordered ascending
 * by attempt count (empty buckets between observed values are omitted, matching
 * how `patterns`/`errors` only emit rows that actually occurred).
 */
export function summarizeAttempts(jobs: RelayJob[]): AttemptDistribution {
  const counts = new Map<number, number>();
  let totalAttempts = 0;
  let retriedJobs = 0;
  let neverResumed = 0;
  let maxAttempts = 0;

  for (const job of jobs) {
    const key = attemptKey(job.attempts);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    totalAttempts += key;
    if (key > 1) retriedJobs += 1;
    if (key === 0) neverResumed += 1;
    if (key > maxAttempts) maxAttempts = key;
  }

  const buckets = [...counts.entries()]
    .map(([attempts, count]) => ({ attempts, count }))
    .sort((a, b) => a.attempts - b.attempts);

  return {
    total: jobs.length,
    totalAttempts,
    retriedJobs,
    neverResumed,
    maxAttempts,
    meanAttempts: jobs.length > 0 ? totalAttempts / jobs.length : null,
    buckets,
  };
}
