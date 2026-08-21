import type { RelayJob } from "./types.js";

/**
 * Which timestamp on a job's persisted rate-limit detection the hour-of-day
 * clock buckets on:
 *
 * - `"detected"` — `lastRateLimit.detectedAt`: *when the relay actually hit the
 *   limit*. This is the behavioural signal — "I keep getting throttled around
 *   15:00" — and it is genuinely distinct from a job's `createdAt` (what every
 *   `stats --hours`/`--weekday`/`--heatmap` histogram buckets on): a job created
 *   once can hit a limit on a resume hours later, so its detection hour can land
 *   in a completely different bucket than its creation hour.
 * - `"reset"` — `lastRateLimit.resetAt`: *when the quota window rolls over*.
 *   When your provider resets on a fixed wall-clock cadence this clusters into
 *   the recurring reset window, so you can schedule heavy work right after it.
 */
export type ResetClockBasis = "detected" | "reset";

/** All valid {@link ResetClockBasis} values, for CLI validation/help. */
export const RESET_CLOCK_BASES: readonly ResetClockBasis[] = ["detected", "reset"] as const;

export interface ResetClockOptions {
  /** Which detection timestamp to bucket on (default `"detected"`). */
  basis?: ResetClockBasis;
  /**
   * Minutes to shift each timestamp before its hour-of-day is read, so callers
   * can bucket by a local wall clock instead of UTC (e.g. `540` for UTC+09:00).
   * Defaults to `0` (UTC), keeping the pure/testable contract — the caller
   * passes the zone offset explicitly rather than the function reading the
   * machine clock. Matches `computeHourlyDistribution` in stats.ts.
   */
  offsetMinutes?: number;
}

/** One hour-of-day bucket in the reset clock. */
export interface ResetClockHour {
  /** Hour of day, 0–23, in the requested zone (UTC unless an offset is given). */
  hour: number;
  /** Detections whose bucketed timestamp falls in this hour, across every day. */
  count: number;
}

/**
 * Hour-of-day distribution of a queue's rate-limit detections — a 24-bucket
 * clock answering "*when* do I keep hitting the limit?" (or, with `basis:
 * "reset"`, "*when* does my quota window roll over?"). Every existing histogram
 * (`stats --hours`/`--weekday`/`--heatmap`) buckets on `createdAt`; this is the
 * only view keyed off the persisted {@link RateLimitDetection} provenance, so it
 * reflects real throttling behaviour rather than when jobs happened to be
 * enqueued. Pure and clock-free: hour-of-day is an absolute property of each
 * timestamp, so no `now` is needed.
 */
export interface ResetClock {
  /** Which timestamp was bucketed (`detected`/`reset`). */
  basis: ResetClockBasis;
  /** The UTC offset (minutes) the hours were bucketed in; `0` = UTC. */
  offsetMinutes: number;
  /** Always exactly 24 entries, hour 0 → 23, zero-filled for quiet hours. */
  hours: ResetClockHour[];
  /** Total detections placed on the clock (jobs with a parseable timestamp). */
  total: number;
  /**
   * Jobs carrying a `lastRateLimit` detection whose chosen timestamp could not
   * be parsed (and so are absent from `total`). Almost always 0; surfaced so the
   * caller can report honest coverage instead of silently dropping rows.
   */
  unparseable: number;
  /**
   * The busiest hour (0–23) — the mode of the distribution. On a tie the
   * earliest hour wins, so the pick is deterministic. `null` only when `total`
   * is 0 (nothing to place on the clock).
   */
  busiestHour: number | null;
  /** How many detections fall in {@link busiestHour}; `0` when `total` is 0. */
  busiestCount: number;
}

/**
 * Read the chosen detection timestamp off a job, or `undefined` when the job
 * carries no rate-limit provenance (never throttled, or a store written before
 * the field existed). Kept separate so both the count and the parse guard share
 * exactly one notion of "which field".
 */
function detectionTimestamp(job: RelayJob, basis: ResetClockBasis): string | undefined {
  const detection = job.lastRateLimit;
  if (!detection) return undefined;
  return basis === "reset" ? detection.resetAt : detection.detectedAt;
}

/**
 * Build the {@link ResetClock} for a job list. Jobs without a `lastRateLimit`
 * detection are skipped entirely (they were never throttled); jobs that carry
 * one but whose chosen timestamp is missing/unparseable are counted in
 * `unparseable` rather than dropped silently. The result is always 24
 * zero-filled hour buckets so the histogram has a stable shape even for an empty
 * or single-detection queue.
 */
export function computeResetClock(jobs: RelayJob[], options: ResetClockOptions = {}): ResetClock {
  const basis: ResetClockBasis = options.basis ?? "detected";
  const offsetMinutes = options.offsetMinutes ?? 0;
  const shiftMs = offsetMinutes * 60_000;

  const counts = new Array<number>(24).fill(0);
  let total = 0;
  let unparseable = 0;

  for (const job of jobs) {
    const stamp = detectionTimestamp(job, basis);
    if (stamp === undefined) continue; // never throttled — not part of the clock
    const ms = Date.parse(stamp);
    if (Number.isNaN(ms)) {
      unparseable += 1;
      continue;
    }
    counts[new Date(ms + shiftMs).getUTCHours()] += 1;
    total += 1;
  }

  let busiestHour: number | null = null;
  let busiestCount = 0;
  if (total > 0) {
    for (let hour = 0; hour < 24; hour++) {
      if (counts[hour] > busiestCount) {
        busiestCount = counts[hour];
        busiestHour = hour;
      }
    }
  }

  return {
    basis,
    offsetMinutes,
    hours: counts.map((count, hour) => ({ hour, count })),
    total,
    unparseable,
    busiestHour,
    busiestCount,
  };
}
