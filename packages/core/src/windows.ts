import type { AgentTool, RelayJob } from "./types.js";

/**
 * One rate-limit "wait window": how long a single detected rate limit forced the
 * relay to pause a job, measured as `resetAt − detectedAt` from the persisted
 * {@link RateLimitDetection} provenance on `lastRateLimit`. This is the metric
 * that quantifies AgentRelay's whole reason to exist — the wall-clock the tool
 * babysat unattended so a human didn't have to sit and wait for a usage window.
 */
export interface RateLimitWindow {
  /** Id of the job this window belongs to (feed to `agentrelay show`). */
  jobId: string;
  /** The job's project label. */
  project: string;
  /** The tool that hit the rate limit. */
  tool: AgentTool;
  /** Parser pattern that produced this detection (`(unknown)` when unnamed). */
  pattern: string;
  /** ISO timestamp the detection was recorded. */
  detectedAt: string;
  /** ISO timestamp of the reset this detection produced. */
  resetAt: string;
  /** `resetAt − detectedAt` in ms — always ≥ 0 (skewed/negative spans are dropped). */
  waitMs: number;
}

/** Per-pattern rollup of the wait windows a given parser pattern accounts for. */
export interface WindowPatternStat {
  /** Parser pattern name (`(unknown)` bucket collects unnamed detections). */
  pattern: string;
  /** Number of windows attributed to this pattern. */
  count: number;
  /** Total wait time (ms) this pattern accounts for. */
  totalWaitMs: number;
  /** Mean wait time (ms) for this pattern's windows (rounded). */
  avgWaitMs: number;
}

/**
 * Fleet-wide summary of rate-limit wait windows for `agentrelay windows`. Pure,
 * derived only from each job's persisted `lastRateLimit` — no clock, no I/O — so
 * the whole command is unit-testable end to end.
 */
export interface RateLimitWindowSummary {
  /** Jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Jobs contributing a usable window (parseable, non-negative span). */
  withWindow: number;
  /** Jobs with no usable window (no detection, or unparseable/negative span). */
  withoutWindow: number;
  /** Sum of every window's `waitMs` — the total time rate limits cost. */
  totalWaitMs: number;
  /** Mean window (ms), or null when no windows. */
  avgWaitMs: number | null;
  /** Shortest window (ms), or null when no windows. */
  minWaitMs: number | null;
  /** Longest window (ms), or null when no windows. */
  maxWaitMs: number | null;
  /** Median (p50) window (ms), or null when no windows. */
  medianWaitMs: number | null;
  /** 90th-percentile window (ms), or null when no windows. */
  p90WaitMs: number | null;
  /** Per-pattern rollup, ranked by total wait time desc (pattern asc tiebreak). */
  byPattern: WindowPatternStat[];
  /** The longest individual windows, longest first (bounded by `limit`). */
  longest: RateLimitWindow[];
}

export interface WindowOptions {
  /**
   * Cap on how many entries `longest` returns (default 5). A value ≤ 0 returns
   * every window (no cap). The aggregate fields always reflect *all* windows
   * regardless of this cap, so nothing here silently hides work.
   */
  limit?: number;
}

/** Bucket label for detections whose parser pattern name is empty/missing. */
export const UNKNOWN_PATTERN_LABEL = "(unknown)";

/** Default number of longest windows surfaced when the caller doesn't specify. */
export const DEFAULT_WINDOW_LIMIT = 5;

/**
 * Linear-interpolated percentile (0..1) over an ascending-sorted, non-empty
 * array — the same "type 7" / NumPy-default definition `stats.ts` uses for
 * resolution-time percentiles, kept local here so this module stays additive and
 * doesn't reach into another module's private helper. Result rounded to whole ms.
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
 * Extract the usable wait window from a single job, or null when the job carries
 * no detection or the timestamps don't yield a sane (non-negative, parseable)
 * span. A negative span means the recorded reset predates the detection — clock
 * skew or a malformed store — so it's dropped rather than clamped, mirroring the
 * skip-don't-clamp policy `stats.ts` uses for resolution times.
 */
export function jobWaitWindow(job: RelayJob): RateLimitWindow | null {
  const detection = job.lastRateLimit;
  if (!detection) return null;
  const detectedAt = typeof detection.detectedAt === "string" ? detection.detectedAt : "";
  const resetAt = typeof detection.resetAt === "string" ? detection.resetAt : "";
  const detectedMs = Date.parse(detectedAt);
  const resetMs = Date.parse(resetAt);
  if (Number.isNaN(detectedMs) || Number.isNaN(resetMs)) return null;
  const waitMs = resetMs - detectedMs;
  if (waitMs < 0) return null;
  const pattern =
    typeof detection.pattern === "string" && detection.pattern.length > 0 ? detection.pattern : UNKNOWN_PATTERN_LABEL;
  return { jobId: job.id, project: job.project, tool: job.tool, pattern, detectedAt, resetAt, waitMs };
}

/**
 * Aggregates rate-limit wait windows across a job list for `agentrelay windows`.
 * Pure and non-mutating: reads only each job's persisted `lastRateLimit`, never a
 * wall clock, and returns fresh arrays so callers never alias the store.
 */
export function summarizeRateLimitWindows(jobs: RelayJob[], options: WindowOptions = {}): RateLimitWindowSummary {
  const windows: RateLimitWindow[] = [];
  for (const job of jobs) {
    const w = jobWaitWindow(job);
    if (w) windows.push(w);
  }

  const withWindow = windows.length;
  const total = jobs.length;

  if (withWindow === 0) {
    return {
      total,
      withWindow: 0,
      withoutWindow: total,
      totalWaitMs: 0,
      avgWaitMs: null,
      minWaitMs: null,
      maxWaitMs: null,
      medianWaitMs: null,
      p90WaitMs: null,
      byPattern: [],
      longest: [],
    };
  }

  // Per-pattern rollup.
  const patternBuckets = new Map<string, { count: number; totalWaitMs: number }>();
  let totalWaitMs = 0;
  for (const w of windows) {
    totalWaitMs += w.waitMs;
    const bucket = patternBuckets.get(w.pattern) ?? { count: 0, totalWaitMs: 0 };
    bucket.count += 1;
    bucket.totalWaitMs += w.waitMs;
    patternBuckets.set(w.pattern, bucket);
  }
  const byPattern: WindowPatternStat[] = [...patternBuckets.entries()]
    .map(([pattern, b]) => ({
      pattern,
      count: b.count,
      totalWaitMs: b.totalWaitMs,
      avgWaitMs: Math.round(b.totalWaitMs / b.count),
    }))
    .sort((a, b) =>
      b.totalWaitMs !== a.totalWaitMs ? b.totalWaitMs - a.totalWaitMs : a.pattern.localeCompare(b.pattern)
    );

  // Percentiles read from a single ascending sort; min/max are its ends.
  const sortedAsc = windows.map((w) => w.waitMs).sort((a, b) => a - b);

  // `longest` — a copy sorted by waitMs desc (jobId asc tiebreak), then capped.
  const longestSorted = [...windows].sort((a, b) =>
    b.waitMs !== a.waitMs ? b.waitMs - a.waitMs : a.jobId.localeCompare(b.jobId)
  );
  const limit = options.limit ?? DEFAULT_WINDOW_LIMIT;
  const longest = limit > 0 ? longestSorted.slice(0, limit) : longestSorted;

  return {
    total,
    withWindow,
    withoutWindow: total - withWindow,
    totalWaitMs,
    avgWaitMs: Math.round(totalWaitMs / withWindow),
    minWaitMs: sortedAsc[0],
    maxWaitMs: sortedAsc[sortedAsc.length - 1],
    medianWaitMs: percentile(sortedAsc, 0.5),
    p90WaitMs: percentile(sortedAsc, 0.9),
    byPattern,
    longest,
  };
}
