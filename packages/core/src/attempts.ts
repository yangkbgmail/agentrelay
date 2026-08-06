import { ACTIVE_STATUSES } from "./stats.js";
import type { JobStatus, RelayJob } from "./types.js";

/**
 * Attempt-count distribution for `agentrelay attempts` — a histogram of how many
 * resume attempts each job needed, keyed off `job.attempts`. `stats` already
 * reports the *sum* of attempts and the *count* of retried jobs, but not the
 * shape: how many jobs the relay resolved on the very first resume vs. how many
 * needed two, three, or more passes before the usage window let them through.
 * That shape is the clearest read on relay effectiveness — a long right tail
 * means jobs keep re-colliding with the limit, a spike at 1 means the relay is
 * getting them through cleanly. This fills that gap: one bucket per distinct
 * attempts count, split into still-active vs. terminal so a maintainer can tell
 * whether the high-attempt jobs already resolved or are still churning.
 */
export interface AttemptBucket {
  /** The attempts count this bucket represents (0, 1, 2, ...). */
  attempts: number;
  /** Total jobs with exactly this many attempts (within any scope applied). */
  count: number;
  /** Of those, jobs still in-flight: queued + waiting_for_reset + resuming. */
  active: number;
  /** Of those, jobs in a terminal state: completed + failed + cancelled. */
  terminal: number;
}

/**
 * Fleet-wide attempt histogram: the headline aggregates (kept in sync with the
 * matching fields on {@link import("./stats.js").RelayStats}) plus the per-count
 * breakdown ranked ascending by attempts, so the histogram reads left-to-right
 * from "resolved on the first pass" toward the retry tail.
 */
export interface AttemptDistribution {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Sum of `attempts` across every job — matches `RelayStats.totalAttempts`. */
  totalAttempts: number;
  /** Jobs resumed more than once (attempts > 1) — matches `RelayStats.retriedJobs`. */
  retriedJobs: number;
  /** The highest attempts count seen, or 0 when there are no jobs. */
  maxAttempts: number;
  /** Mean attempts per job, or null when there are no jobs (avoids NaN). */
  meanAttempts: number | null;
  /** One bucket per distinct attempts count, ascending by `attempts`. */
  buckets: AttemptBucket[];
}

const ACTIVE_SET = new Set<JobStatus>(ACTIVE_STATUSES);

/**
 * Coerce a job's `attempts` into a non-negative integer. A hand-edited or
 * legacy store could carry a negative, fractional, or non-finite value; rather
 * than let that skew the histogram (or open a bucket keyed on `NaN`), clamp to
 * the nearest sane count. This mirrors how the rest of the analytics layer
 * defends against corrupt store fields.
 */
function normalizeAttempts(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

/**
 * Groups a job list into an attempt-count histogram for `agentrelay attempts`.
 * Pure and non-mutating: no I/O, no ambient clock. The aggregate fields
 * (`totalAttempts`, `retriedJobs`) use the *same* definitions as `computeStats`
 * so the two commands never disagree — `totalAttempts` sums the normalized
 * counts and `retriedJobs` counts jobs whose normalized count exceeds 1.
 *
 * Buckets are ranked ascending by `attempts` (a natural histogram axis), not by
 * frequency, so the output always reads first-attempt → retry-tail.
 */
export function computeAttemptDistribution(jobs: RelayJob[]): AttemptDistribution {
  const buckets = new Map<number, AttemptBucket>();
  let totalAttempts = 0;
  let retriedJobs = 0;
  let maxAttempts = 0;

  for (const job of jobs) {
    const attempts = normalizeAttempts(job.attempts);
    totalAttempts += attempts;
    if (attempts > 1) retriedJobs += 1;
    if (attempts > maxAttempts) maxAttempts = attempts;

    let bucket = buckets.get(attempts);
    if (!bucket) {
      bucket = { attempts, count: 0, active: 0, terminal: 0 };
      buckets.set(attempts, bucket);
    }
    bucket.count += 1;
    if (ACTIVE_SET.has(job.status)) bucket.active += 1;
    else bucket.terminal += 1;
  }

  const ranked = [...buckets.values()].sort((a, b) => a.attempts - b.attempts);
  const total = jobs.length;

  return {
    total,
    totalAttempts,
    retriedJobs,
    maxAttempts,
    meanAttempts: total === 0 ? null : totalAttempts / total,
    buckets: ranked,
  };
}
