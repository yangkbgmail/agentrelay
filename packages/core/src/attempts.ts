import type { RelayJob } from "./types.js";

/**
 * One row of the retry-attempt histogram for `agentrelay attempts`: all jobs
 * that have burned exactly `attempts` resume attempts, and their ids. Where
 * `agentrelay errors` answers *why* jobs fail, this answers *how hard the relay
 * is working* — how many resume attempts each job consumed. A `job.attempts` of
 * 0 means the job was enqueued but never resumed yet (still queued / waiting for
 * its first reset); 1 means it resumed once, N means it was re-parked and
 * resumed N times.
 */
export interface AttemptBucket {
  /** The exact `job.attempts` value shared by every job in this bucket. */
  attempts: number;
  /** How many jobs have burned exactly this many attempts. */
  count: number;
  /** Ids of the jobs in this bucket, in first-seen order (feed to `agentrelay show`). */
  jobIds: string[];
}

/**
 * Fleet-wide distribution of resume attempts, so a maintainer can see at a
 * glance whether the relay is coasting (most jobs at 0–1 attempts) or grinding
 * (a long tail of jobs re-parked over and over), and — when the configured
 * retry ceiling is known — how many jobs are pressed against it and about to be
 * abandoned.
 */
export interface AttemptsSummary {
  /** Jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Sum of `attempts` across all considered jobs. */
  totalAttempts: number;
  /** Jobs that have been re-attempted at least once (attempts >= 2). */
  retried: number;
  /** Jobs enqueued but not yet resumed even once (attempts === 0). */
  neverAttempted: number;
  /** The highest `attempts` value observed, or 0 for an empty set. */
  maxAttempts: number;
  /**
   * The configured retry ceiling this summary was scoped against (echoed from
   * the caller's `maxAttempts` option), or null when no ceiling was supplied or
   * it was unlimited (`<= 0`). When present, {@link atCeiling} is meaningful.
   */
  ceiling: number | null;
  /**
   * Jobs whose `attempts` have reached or passed {@link ceiling} — the ones the
   * relay's `maxAttempts` policy would refuse to retry further. 0 when no finite
   * ceiling was supplied. Mirrors `isRetryExhausted`'s `attemptNumber >=
   * maxAttempts` boundary.
   */
  atCeiling: number;
  /** Histogram rows, one per distinct `attempts` value, sorted by attempts asc. */
  buckets: AttemptBucket[];
}

/** Options for {@link summarizeAttempts}. */
export interface AttemptsOptions {
  /**
   * The effective retry ceiling (`RetryPolicy.maxAttempts`) to measure jobs
   * against. A finite positive value populates {@link AttemptsSummary.ceiling}
   * and {@link AttemptsSummary.atCeiling}; `<= 0` (unlimited) or omitted leaves
   * both inert — matching how `isRetryExhausted` treats `maxAttempts <= 0` as
   * "never exhausted".
   */
  maxAttempts?: number;
}

/**
 * Builds the retry-attempt histogram for a job list. Pure and non-mutating: no
 * I/O, no ambient clock, input untouched. Buckets are keyed by the raw
 * `job.attempts` integer and returned sorted ascending, so the output reads as
 * a distribution (0, 1, 2, … attempts) rather than a ranking. When a finite
 * `maxAttempts` ceiling is supplied, jobs at or above it are counted in
 * `atCeiling` using the exact `attempts >= maxAttempts` boundary
 * `isRetryExhausted` uses, so the two never disagree about which jobs are spent.
 */
export function summarizeAttempts(jobs: RelayJob[], options: AttemptsOptions = {}): AttemptsSummary {
  const rawCeiling = options.maxAttempts;
  // Only a finite, positive ceiling is meaningful; `<= 0` means "unlimited"
  // (same convention as isRetryExhausted), so we treat it as no ceiling.
  const ceiling =
    typeof rawCeiling === "number" && Number.isFinite(rawCeiling) && rawCeiling > 0 ? Math.floor(rawCeiling) : null;

  const buckets = new Map<number, AttemptBucket>();
  let totalAttempts = 0;
  let retried = 0;
  let neverAttempted = 0;
  let maxAttempts = 0;
  let atCeiling = 0;

  for (const job of jobs) {
    // Defensive: a malformed store could carry a non-integer/negative attempts;
    // clamp so the histogram keys stay clean integers >= 0.
    const attempts = Number.isFinite(job.attempts) ? Math.max(0, Math.floor(job.attempts)) : 0;

    let bucket = buckets.get(attempts);
    if (!bucket) {
      bucket = { attempts, count: 0, jobIds: [] };
      buckets.set(attempts, bucket);
    }
    bucket.count += 1;
    bucket.jobIds.push(job.id);

    totalAttempts += attempts;
    if (attempts >= 2) retried += 1;
    if (attempts === 0) neverAttempted += 1;
    if (attempts > maxAttempts) maxAttempts = attempts;
    if (ceiling !== null && attempts >= ceiling) atCeiling += 1;
  }

  const sorted = [...buckets.values()].sort((a, b) => a.attempts - b.attempts);

  return {
    total: jobs.length,
    totalAttempts,
    retried,
    neverAttempted,
    maxAttempts,
    ceiling,
    atCeiling,
    buckets: sorted,
  };
}
