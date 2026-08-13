import type { RelayJob } from "./types.js";

/**
 * How much unattended rate-limit waiting the relay covered on your behalf.
 *
 * Every time a job is parked in `waiting_for_reset`, the queue records a
 * {@link RateLimitDetection} on `lastRateLimit` with both when the limit was
 * seen (`detectedAt`) and when it was expected to lift (`resetAt`). The span
 * between the two is a window a user would otherwise have had to sit and watch
 * before manually re-running the command. Summed across the queue, that total
 * is the headline value AgentRelay delivers: hands-off time it handled instead
 * of you — the single number that answers "was running the relay worth it?".
 *
 * This is deliberately distinct from `agentrelay stats` resolution time (the
 * full create→terminal lifecycle of a job): a job can sit hours between reset
 * windows yet resolve in seconds of actual work, and vice-versa. Coverage
 * isolates the *waiting* the relay absorbed.
 */
export interface CoveredWindow {
  /** The job whose detection produced this window. */
  jobId: string;
  /** The job's project (for a human-legible "biggest window" callout). */
  project: string;
  /** The parser pattern that matched the rate-limit message. */
  pattern: string;
  /** The covered wait window (ms): `resetAt − detectedAt`, clamped to `≥ 0`. */
  waitMs: number;
}

/** Per-parser-pattern rollup of covered windows, for the pattern breakdown. */
export interface CoverageByPattern {
  /** Name of the parser pattern (see parser.ts / adapters.ts). */
  pattern: string;
  /** How many covered windows this pattern accounts for. */
  count: number;
  /** Sum of `waitMs` across those windows. */
  totalWaitMs: number;
}

/**
 * Fleet-wide summary of covered rate-limit wait. Only jobs carrying a usable
 * `lastRateLimit` (non-empty pattern name and both `detectedAt`/`resetAt`
 * parseable) contribute a window; everything else is silently excluded, so a
 * store with no detections yields a zeroed, empty report rather than an error.
 */
export interface RelayCoverage {
  /** Jobs that contributed a valid covered window. */
  windowCount: number;
  /** Σ `waitMs` — the total unattended rate-limit wait the relay bridged. */
  totalWaitMs: number;
  /** Mean window (ms), or null when {@link windowCount} is 0. */
  avgWaitMs: number | null;
  /** Shortest window (ms), or null when none. */
  minWaitMs: number | null;
  /** Longest window (ms), or null when none. */
  maxWaitMs: number | null;
  /** Median (p50) window (ms) — the typical wait — or null when none. */
  medianWaitMs: number | null;
  /** 90th-percentile window (ms) — the near-worst-case wait — or null when none. */
  p90WaitMs: number | null;
  /** The single longest covered window, or null when none. */
  longest: CoveredWindow | null;
  /** Per-pattern breakdown, ranked by totalWaitMs (desc), ties by pattern (asc). */
  byPattern: CoverageByPattern[];
}

/**
 * Linear-interpolation percentile over a non-empty ascending list (NumPy
 * default / "type 7": rank = p·(n−1), interpolate the two straddling samples).
 * Rounded to whole ms. Mirrors the helper in stats.ts; kept local so this
 * module has no cross-dependency on the stats internals. Caller guarantees a
 * non-empty, ascending input.
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
 * Aggregates the persisted `lastRateLimit` provenance across a job list into a
 * coverage report for `agentrelay coverage`. Pure and non-mutating: no I/O, no
 * ambient clock — every window is computed from the detection's own recorded
 * `detectedAt`/`resetAt`, never a wall clock, so the result is fully
 * deterministic and depends only on the input jobs.
 *
 * A job contributes a window only when its `lastRateLimit` has a non-empty
 * `pattern` and both `detectedAt` and `resetAt` parse to real timestamps. A
 * window whose `resetAt` precedes its `detectedAt` (a clock skew or a
 * already-past reset) clamps to `0` rather than going negative, so it counts as
 * a real-but-instant window instead of poisoning the totals.
 */
export function computeRelayCoverage(jobs: RelayJob[]): RelayCoverage {
  const windows: CoveredWindow[] = [];
  const patternBuckets = new Map<string, CoverageByPattern>();

  for (const job of jobs) {
    const detection = job.lastRateLimit;
    const pattern = detection?.pattern;
    if (!detection || typeof pattern !== "string" || pattern.length === 0) continue;

    const detectedMs = Date.parse(detection.detectedAt);
    const resetMs = Date.parse(detection.resetAt);
    if (Number.isNaN(detectedMs) || Number.isNaN(resetMs)) continue;

    const waitMs = Math.max(0, resetMs - detectedMs);
    windows.push({ jobId: job.id, project: job.project, pattern, waitMs });

    const bucket = patternBuckets.get(pattern);
    if (!bucket) {
      patternBuckets.set(pattern, { pattern, count: 1, totalWaitMs: waitMs });
    } else {
      bucket.count += 1;
      bucket.totalWaitMs += waitMs;
    }
  }

  const windowCount = windows.length;
  if (windowCount === 0) {
    return {
      windowCount: 0,
      totalWaitMs: 0,
      avgWaitMs: null,
      minWaitMs: null,
      maxWaitMs: null,
      medianWaitMs: null,
      p90WaitMs: null,
      longest: null,
      byPattern: [],
    };
  }

  const waits = windows.map((w) => w.waitMs);
  const totalWaitMs = waits.reduce((sum, v) => sum + v, 0);
  const sorted = [...waits].sort((a, b) => a - b);
  // First strict-max wins ties, so the callout is deterministic for a given
  // input order.
  const longest = windows.reduce((best, w) => (w.waitMs > best.waitMs ? w : best), windows[0]);

  const byPattern = [...patternBuckets.values()].sort((a, b) =>
    b.totalWaitMs !== a.totalWaitMs ? b.totalWaitMs - a.totalWaitMs : a.pattern.localeCompare(b.pattern)
  );

  return {
    windowCount,
    totalWaitMs,
    avgWaitMs: Math.round(totalWaitMs / windowCount),
    minWaitMs: sorted[0],
    maxWaitMs: sorted[sorted.length - 1],
    medianWaitMs: percentile(sorted, 0.5),
    p90WaitMs: percentile(sorted, 0.9),
    longest,
    byPattern,
  };
}
