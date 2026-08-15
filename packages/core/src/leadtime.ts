import type { RelayJob } from "./types.js";

/**
 * Reset-window (lead-time) analytics for `agentrelay windows`.
 *
 * Every time the relay parks a job in `waiting_for_reset`, it persists a
 * {@link RateLimitDetection} on `job.lastRateLimit` recording *when* the limit
 * was detected (`detectedAt`) and *when* it was judged to reset (`resetAt`).
 * The gap between the two — `resetAt − detectedAt` — is the **lead time**: how
 * far in the future the reset was set, i.e. the length of the rate-limit window
 * the relay actually had to wait out.
 *
 * That distribution is the single most product-defining number this tool can
 * report and nothing surfaces it today: `stats` measures the job *lifecycle*
 * (createdAt→updatedAt, including resume), and `patterns` counts *which* formats
 * fired — neither answers "how long are my rate-limit windows?" (a 5-hour usage
 * window vs a multi-day weekly cap look identical to those). Knowing the typical
 * and tail lead time tells a user how long their agent sits idle per limit hit,
 * and the per-pattern split reveals which message formats imply short vs long
 * waits.
 *
 * Everything here is pure: no I/O, no ambient clock. The "now" is irrelevant —
 * a lead time is computed entirely from two timestamps the detection already
 * carries, so the result is fully determined by the job list.
 */

/** Per-pattern lead-time rollup: which message formats imply short vs long waits. */
export interface LeadTimePatternStat {
  /** Name of the parser pattern that produced these detections (see parser.ts). */
  pattern: string;
  /** Usable lead-time samples attributed to this pattern. */
  count: number;
  /** Mean lead time (ms) across this pattern's samples, rounded to whole ms. */
  avgMs: number;
  /** Shortest lead time (ms) seen for this pattern. */
  minMs: number;
  /** Longest lead time (ms) seen for this pattern. */
  maxMs: number;
}

/**
 * Fleet-wide summary of reset-window lead times. `count` is the number of
 * *usable* samples (a detection with two parseable timestamps and a
 * non-negative span); the central-tendency fields are `null` exactly when
 * `count` is 0. `skipped` counts detections that were present but unusable
 * (unparseable timestamps, or a negative span from clock skew / a reset already
 * in the past at detection), kept visible rather than silently dropped.
 */
export interface LeadTimeSummary {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Jobs carrying a usable rate-limit detection (a non-empty pattern name). */
  withDetection: number;
  /** Jobs with no detection recorded (never rate-limited, or a pre-provenance store). */
  withoutDetection: number;
  /** Usable lead-time samples: detections with parseable timestamps and span ≥ 0. */
  count: number;
  /** Detections present but unusable (bad timestamps or negative span). */
  skipped: number;
  /** Mean lead time (ms), or null when `count` is 0. */
  avgMs: number | null;
  /** Shortest lead time (ms), or null when `count` is 0. */
  minMs: number | null;
  /** Longest lead time (ms), or null when `count` is 0. */
  maxMs: number | null;
  /** Median (p50) lead time (ms), or null when `count` is 0. */
  medianMs: number | null;
  /** p90 lead time (ms) — the tail wait, or null when `count` is 0. */
  p90Ms: number | null;
  /** Per-pattern breakdown, ranked by count (desc), ties broken by pattern name (asc). */
  byPattern: LeadTimePatternStat[];
}

/**
 * Linear-interpolated percentile (0..1) over an ascending-sorted, non-empty
 * array. p=0.5 → median, p=0.9 → p90. Matches the common "type 7" / NumPy
 * default used elsewhere in this codebase (see stats.ts): rank = p·(n−1),
 * interpolate between the two straddling samples, round to whole ms. Callers
 * guarantee `sortedAsc.length > 0`.
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

/** Epoch ms of an ISO timestamp, or NaN when missing/unparseable. */
function parseMs(iso: unknown): number {
  return typeof iso === "string" ? Date.parse(iso) : Number.NaN;
}

/**
 * Aggregates persisted `lastRateLimit` provenance across a job list into a
 * lead-time (reset-window) distribution for `agentrelay windows`. Pure and
 * non-mutating: no I/O, no ambient clock.
 *
 * A job contributes a lead-time sample only when it carries a `lastRateLimit`
 * with a non-empty `pattern` (counted as `withDetection`) *and* both its
 * `detectedAt` and `resetAt` parse to valid instants with `resetAt ≥ detectedAt`.
 * A detection present but failing that second test is counted in `skipped`
 * (never as a negative or fabricated span) — mirroring the resolution-time
 * policy in stats.ts of skipping, not clamping, nonsensical spans.
 */
export function computeLeadTimes(jobs: RelayJob[]): LeadTimeSummary {
  const samples: number[] = [];
  const byPattern = new Map<string, { count: number; sum: number; min: number; max: number }>();
  let withDetection = 0;
  let skipped = 0;

  for (const job of jobs) {
    const detection = job.lastRateLimit;
    const pattern = detection?.pattern;
    if (!detection || typeof pattern !== "string" || pattern.length === 0) continue;

    withDetection += 1;

    const detectedMs = parseMs(detection.detectedAt);
    const resetMs = parseMs(detection.resetAt);
    const span = resetMs - detectedMs;
    // Skip (don't clamp) unparseable timestamps or a negative window — a reset
    // recorded as earlier than its own detection is clock skew, not a real wait.
    if (!Number.isFinite(span) || span < 0) {
      skipped += 1;
      continue;
    }

    samples.push(span);
    const existing = byPattern.get(pattern);
    if (!existing) {
      byPattern.set(pattern, { count: 1, sum: span, min: span, max: span });
    } else {
      existing.count += 1;
      existing.sum += span;
      if (span < existing.min) existing.min = span;
      if (span > existing.max) existing.max = span;
    }
  }

  const count = samples.length;
  let avgMs: number | null = null;
  let minMs: number | null = null;
  let maxMs: number | null = null;
  let medianMs: number | null = null;
  let p90Ms: number | null = null;

  if (count > 0) {
    const sorted = [...samples].sort((a, b) => a - b);
    minMs = sorted[0];
    maxMs = sorted[sorted.length - 1];
    avgMs = Math.round(sorted.reduce((s, v) => s + v, 0) / count);
    medianMs = percentile(sorted, 0.5);
    p90Ms = percentile(sorted, 0.9);
  }

  const patterns: LeadTimePatternStat[] = [...byPattern.entries()]
    .map(([pattern, agg]) => ({
      pattern,
      count: agg.count,
      avgMs: Math.round(agg.sum / agg.count),
      minMs: agg.min,
      maxMs: agg.max,
    }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.pattern.localeCompare(b.pattern)));

  return {
    total: jobs.length,
    withDetection,
    withoutDetection: jobs.length - withDetection,
    count,
    skipped,
    avgMs,
    minMs,
    maxMs,
    medianMs,
    p90Ms,
    byPattern: patterns,
  };
}
