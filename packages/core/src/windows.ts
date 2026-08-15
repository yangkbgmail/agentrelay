import type { RelayJob } from "./types.js";

/**
 * Distribution of *rate-limit window* durations the relay has observed, built
 * from the persisted {@link RateLimitDetection} provenance on each job. A
 * "window" is the lead time a detection recorded — how far in the future the
 * reset was from the moment it was detected (`resetAt − detectedAt`).
 *
 * This is distinct from `agentrelay stats` resolution time (the full job
 * lifecycle, `updatedAt − createdAt`, which also folds in retry backoff and any
 * wait after the reset before the scheduler actually re-ran it). The window is
 * the raw "how long is the usage lockout itself" — the number a user needs for
 * capacity planning ("my Claude limits reset ~5h out") and the number a
 * maintainer eyeballs to sanity-check the parser (a window of 4 seconds or 40
 * days almost certainly means a mis-parse).
 */
export interface RateLimitWindowStats {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Jobs contributing a valid, non-negative window (both timestamps parseable). */
  withWindow: number;
  /** Jobs with no usable detection window (never rate-limited, or malformed provenance). */
  withoutWindow: number;
  /** Shortest observed window (ms), or null when none. */
  minMs: number | null;
  /** Longest observed window (ms), or null when none. */
  maxMs: number | null;
  /** Mean window (ms) over {@link withWindow} jobs, or null when none. */
  avgMs: number | null;
  /** Median (p50) window (ms) — the typical lockout, unskewed by one outlier. */
  medianMs: number | null;
  /** 90th-percentile window (ms) — the near-worst-case lockout. */
  p90Ms: number | null;
  /** 95th-percentile window (ms) — how long all but the worst 5% of lockouts run. */
  p95Ms: number | null;
}

/**
 * Lead time (ms) of a job's persisted rate-limit detection: `resetAt −
 * detectedAt`, or null when the job carries no detection, either timestamp is
 * missing/unparseable, or the span is negative (a stale detection whose reset
 * already lay in the past, or clock skew). The negative-skip policy mirrors
 * `stats.ts` resolutionMs so both distributions treat bad spans the same way.
 */
function windowMs(job: RelayJob): number | null {
  const detection = job.lastRateLimit;
  if (!detection) return null;
  const detected = Date.parse(detection.detectedAt);
  const reset = Date.parse(detection.resetAt);
  if (Number.isNaN(detected) || Number.isNaN(reset)) return null;
  const span = reset - detected;
  return span >= 0 ? span : null;
}

/**
 * Linear-interpolated percentile (0..1) over an ascending-sorted, non-empty
 * array — the common "type 7" / NumPy default (rank = p·(n−1), interpolate
 * between the two straddling samples), rounded to whole ms. Kept local to this
 * module rather than shared from stats.ts so `windows` stays self-contained.
 * Callers guarantee `sortedAsc.length > 0`.
 */
function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 1) return sortedAsc[0];
  const rank = p * (n - 1);
  const lower = Math.floor(rank);
  const frac = rank - lower;
  if (frac === 0) return sortedAsc[lower];
  return Math.round(sortedAsc[lower] + frac * (sortedAsc[lower + 1] - sortedAsc[lower]));
}

/**
 * Aggregates the persisted `lastRateLimit` windows across a job list into a
 * duration distribution for `agentrelay windows`. Pure and non-mutating: no
 * I/O, no ambient clock — every number comes from each detection's own
 * `detectedAt`/`resetAt`, never a wall clock. Jobs without a usable window are
 * counted in `withoutWindow` rather than skewing the distribution with a zero.
 */
export function computeRateLimitWindows(jobs: RelayJob[]): RateLimitWindowStats {
  const spans: number[] = [];
  for (const job of jobs) {
    const ms = windowMs(job);
    if (ms !== null) spans.push(ms);
  }

  const withWindow = spans.length;
  if (withWindow === 0) {
    return {
      total: jobs.length,
      withWindow: 0,
      withoutWindow: jobs.length,
      minMs: null,
      maxMs: null,
      avgMs: null,
      medianMs: null,
      p90Ms: null,
      p95Ms: null,
    };
  }

  spans.sort((a, b) => a - b);
  const sum = spans.reduce((acc, v) => acc + v, 0);

  return {
    total: jobs.length,
    withWindow,
    withoutWindow: jobs.length - withWindow,
    minMs: spans[0],
    maxMs: spans[withWindow - 1],
    avgMs: Math.round(sum / withWindow),
    medianMs: percentile(spans, 0.5),
    p90Ms: percentile(spans, 0.9),
    p95Ms: percentile(spans, 0.95),
  };
}
