import type { RelayJob } from "./types.js";

/**
 * Default minimum attempt count for a job to appear in the retries report. A
 * job resumed exactly once (`attempts === 1`) ran straight through and isn't
 * interesting here; the whole point of this command is to surface jobs the
 * relay has had to *re-run*, so the floor sits at 2 (matching `stats`'
 * "retriedJobs = attempts > 1" convention).
 */
export const DEFAULT_RETRIES_MIN_ATTEMPTS = 2;

/**
 * One most-retried job, plus the context the CLI needs to render a row.
 * Computed purely from the job list — no clock, no queue, no I/O — so
 * `agentrelay retries` is unit-testable end to end.
 */
export interface RetryEntry {
  /** The job that has burned the most (or at least `minAttempts`) resume attempts. */
  job: RelayJob;
  /** Its attempt count (`job.attempts`) — the ranking key. */
  attempts: number;
  /** 1-based position in the ranking (1 = most retried). */
  position: number;
}

/**
 * The jobs the relay has re-run the most: every job with at least
 * `minAttempts` attempts, ranked most-retried first. Where `errors` groups
 * failures by message and `stats` gives an aggregate retry count, this names
 * the *specific* jobs eating the retry budget — the ones repeatedly hitting
 * rate-limits or transient failures and worth a closer look (`agentrelay show`).
 */
export interface RetriesReport {
  /** Ranked rows, most retried first. Trimmed to `limit` when one was given. */
  entries: RetryEntry[];
  /** How many jobs meet the `minAttempts` floor in total (before any `limit`). */
  totalRetried: number;
  /** How many qualifying jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The `minAttempts` floor that was applied — echoed for callers. */
  minAttempts: number;
  /** Sum of `attempts` across the qualifying jobs (the retry budget they spent). */
  totalAttempts: number;
  /** The single highest attempt count among qualifying jobs (0 when none). */
  maxAttempts: number;
}

/**
 * Order two jobs by which has been retried more: highest attempt count first,
 * then oldest `createdAt`, then id — fully deterministic even when two jobs
 * share an attempt count.
 */
function compareRetried(a: RelayJob, b: RelayJob): number {
  if (a.attempts !== b.attempts) return b.attempts - a.attempts;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the retries report: the jobs with `attempts >= minAttempts`, ranked
 * most-retried first. `minAttempts` is clamped to at least 1 (a floor of 0 or a
 * negative would list single-run jobs, defeating the purpose); a non-integer or
 * missing value falls back to {@link DEFAULT_RETRIES_MIN_ATTEMPTS}.
 *
 * `limit` (a positive integer) trims the returned `entries` to the top N, but
 * `totalRetried`/`totalAttempts`/`maxAttempts` still reflect the full
 * qualifying set so callers can honestly report "N more not shown".
 */
export function buildRetriesReport(
  jobs: RelayJob[],
  options: { minAttempts?: number; limit?: number } = {}
): RetriesReport {
  const minAttempts =
    typeof options.minAttempts === "number" && Number.isInteger(options.minAttempts) && options.minAttempts >= 1
      ? options.minAttempts
      : DEFAULT_RETRIES_MIN_ATTEMPTS;
  const { limit } = options;

  const retried = jobs.filter((job) => job.attempts >= minAttempts).sort(compareRetried);

  const totalRetried = retried.length;
  const totalAttempts = retried.reduce((sum, job) => sum + job.attempts, 0);
  const maxAttempts = totalRetried === 0 ? 0 : retried[0].attempts;

  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? retried.slice(0, limit) : retried;

  const entries: RetryEntry[] = capped.map((job, index) => ({
    job,
    attempts: job.attempts,
    position: index + 1,
  }));

  return {
    entries,
    totalRetried,
    hidden: totalRetried - entries.length,
    minAttempts,
    totalAttempts,
    maxAttempts,
  };
}
