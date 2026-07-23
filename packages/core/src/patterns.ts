import type { RelayJob } from "./types.js";

/**
 * Aggregate view of a single rate-limit parser pattern across the queue,
 * built from the {@link RateLimitDetection} provenance that
 * {@link RelayQueue.markWaitingForReset} now persists on each job. Answers the
 * fleet-level question the per-job `agentrelay show` block can't: *which*
 * rate-limit message formats actually fire in the wild, and how often — so a
 * maintainer knows which parser patterns are load-bearing and which never
 * match a real message.
 */
export interface RateLimitPatternStat {
  /** Name of the parser pattern (see parser.ts / adapters.ts). */
  pattern: string;
  /** Jobs whose most-recent detection matched this pattern. */
  count: number;
  /** The most recent `detectedAt` (ISO) among those jobs. */
  lastDetectedAt: string;
  /**
   * The raw matched substring from that most-recent detection — a concrete
   * example of the message text this pattern caught, for eyeballing.
   */
  sampleRawMatch: string;
}

/**
 * Fleet-wide summary of persisted rate-limit detections. Each job carries only
 * its *last* detection, so `withDetection` is also the number of detections
 * counted here; a job re-parked by a later rate-limit overwrites its own
 * earlier provenance (we track current state, not a full history).
 */
export interface RateLimitPatternSummary {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Jobs carrying a usable rate-limit detection (a non-empty pattern name). */
  withDetection: number;
  /** Jobs with no detection recorded (never rate-limited, or a pre-provenance store). */
  withoutDetection: number;
  /** Per-pattern breakdown, ranked by count (desc), ties broken by pattern name (asc). */
  patterns: RateLimitPatternStat[];
}

/** Epoch ms of an ISO timestamp, or -Infinity when missing/unparseable (sorts oldest). */
function detectedMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Aggregates the persisted `lastRateLimit` provenance across a job list into a
 * per-pattern frequency table for `agentrelay patterns`. Pure and non-mutating:
 * no I/O, no ambient clock — the "most recent" tiebreak reads each detection's
 * own `detectedAt`, never a wall clock.
 *
 * A job counts toward a pattern only when it carries a `lastRateLimit` whose
 * `pattern` is a non-empty string; anything else (null, missing, or a malformed
 * record loaded from an old store) is counted as `withoutDetection` rather than
 * inventing an empty-named pattern bucket. Within a pattern, `lastDetectedAt`
 * and `sampleRawMatch` come from the detection with the newest `detectedAt`.
 */
export function summarizeRateLimitPatterns(jobs: RelayJob[]): RateLimitPatternSummary {
  const buckets = new Map<string, RateLimitPatternStat>();
  let withDetection = 0;

  for (const job of jobs) {
    const detection = job.lastRateLimit;
    const pattern = detection?.pattern;
    if (!detection || typeof pattern !== "string" || pattern.length === 0) continue;

    withDetection += 1;
    const detectedAt = typeof detection.detectedAt === "string" ? detection.detectedAt : "";
    const rawMatch = typeof detection.rawMatch === "string" ? detection.rawMatch : "";

    const existing = buckets.get(pattern);
    if (!existing) {
      buckets.set(pattern, { pattern, count: 1, lastDetectedAt: detectedAt, sampleRawMatch: rawMatch });
    } else {
      existing.count += 1;
      // Keep the most-recent detection's timestamp and raw sample.
      if (detectedMs(detectedAt) >= detectedMs(existing.lastDetectedAt)) {
        existing.lastDetectedAt = detectedAt;
        existing.sampleRawMatch = rawMatch;
      }
    }
  }

  const patterns = [...buckets.values()].sort((a, b) =>
    b.count !== a.count ? b.count - a.count : a.pattern.localeCompare(b.pattern)
  );

  return {
    total: jobs.length,
    withDetection,
    withoutDetection: jobs.length - withDetection,
    patterns,
  };
}
