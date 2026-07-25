import type { RelayJob } from "./types.js";

/**
 * Count of rate-limit detections that landed in a single hour-of-day bucket.
 * `hour` is the wall-clock hour (0–23) after the caller's `utcOffsetMinutes`
 * has been applied, so the histogram reads in the user's local time.
 */
export interface HourBucket {
  /** Hour of day, 0–23, in the offset-adjusted frame. */
  hour: number;
  /** Detections that fell in this hour. */
  count: number;
}

/**
 * Hour-of-day distribution of *when* rate limits actually hit, built from the
 * persisted {@link RateLimitDetection} provenance (`lastRateLimit.detectedAt`)
 * that `RelayQueue.markWaitingForReset` records on each job. Answers the
 * planning question `patterns` (which format) and `next` (single upcoming) can't:
 * *at what times of day do I get rate-limited?* — so a user can shift heavy runs
 * off their personal peak. Each job carries only its most-recent detection, so
 * `withDetection` is also the number of detections counted (a job re-parked by a
 * later rate-limit overwrites its own earlier provenance).
 */
export interface HourlyRateLimitDistribution {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Jobs whose last detection carried a parseable `detectedAt`. */
  withDetection: number;
  /** Jobs with no usable detection timestamp (never rate-limited, or unparseable). */
  withoutDetection: number;
  /** Offset (minutes east of UTC) applied when bucketing, echoed for display. */
  utcOffsetMinutes: number;
  /** Always 24 buckets, hour 0→23, zero-filled — a stable shape for rendering. */
  buckets: HourBucket[];
  /** Hour (0–23) with the most detections, earliest on a tie; null when none. */
  peakHour: number | null;
  /** Detections in {@link peakHour}; 0 when there are none. */
  peakCount: number;
}

/**
 * The offset-adjusted hour-of-day (0–23) for an epoch-ms instant. Adding the
 * offset to the instant and reading the *UTC* hour of the shifted value yields
 * the wall-clock hour in a frame `utcOffsetMinutes` east of UTC, without ever
 * touching the host's local timezone (so the result is identical on any
 * machine). Pure: the `Date` is constructed from an explicit ms value, never a
 * wall clock.
 */
function hourForDetection(ms: number, utcOffsetMinutes: number): number {
  return new Date(ms + utcOffsetMinutes * 60_000).getUTCHours();
}

/**
 * Aggregates the persisted `lastRateLimit.detectedAt` timestamps across a job
 * list into a 24-bucket hour-of-day histogram for `agentrelay when`. Pure and
 * non-mutating: no I/O, no ambient clock — hours come only from each detection's
 * own recorded timestamp, shifted by the caller-supplied `utcOffsetMinutes`
 * (0 = UTC; the CLI passes the host's offset for a local-time view).
 *
 * A job contributes only when it carries a `lastRateLimit` whose `detectedAt`
 * is a parseable ISO string; anything else (null, missing, malformed) is counted
 * as `withoutDetection` rather than guessing an hour. The offset is normalised
 * to a finite number so a bad caller value can't poison the bucketing.
 */
export function hourlyRateLimitDistribution(
  jobs: RelayJob[],
  options: { utcOffsetMinutes?: number } = {}
): HourlyRateLimitDistribution {
  const raw = options.utcOffsetMinutes;
  const utcOffsetMinutes = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;

  const buckets: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  let withDetection = 0;

  for (const job of jobs) {
    const detectedAt = job.lastRateLimit?.detectedAt;
    if (typeof detectedAt !== "string" || detectedAt.length === 0) continue;
    const ms = Date.parse(detectedAt);
    if (Number.isNaN(ms)) continue;

    withDetection += 1;
    buckets[hourForDetection(ms, utcOffsetMinutes)].count += 1;
  }

  let peakHour: number | null = null;
  let peakCount = 0;
  for (const b of buckets) {
    // Strictly-greater keeps the earliest hour on a tie, matching the buckets'
    // natural 0→23 order.
    if (b.count > peakCount) {
      peakCount = b.count;
      peakHour = b.hour;
    }
  }

  return {
    total: jobs.length,
    withDetection,
    withoutDetection: jobs.length - withDetection,
    utcOffsetMinutes,
    buckets,
    peakHour,
    peakCount,
  };
}
