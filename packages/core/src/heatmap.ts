import type { RelayJob } from "./types.js";

/**
 * Hour-of-day activity distribution for `agentrelay heatmap`.
 *
 * The target user runs an agent all day and hits a rolling 5-hour rate limit
 * whenever cumulative usage crosses the threshold. `stats --trend` shows *how
 * many* jobs were queued per calendar day (a volume timeline), and `patterns`
 * shows *which* rate-limit message fired — but neither answers "**at what time
 * of day** do I keep getting rate-limited?". Folding every job's creation time
 * into 24 hour-of-day buckets exposes the daily rhythm of rate limiting, so a
 * user can see their limits cluster around, say, mid-afternoon and plan work
 * around it.
 *
 * This module holds only the pure aggregation. It never reads a clock or the
 * filesystem: the hour is derived from each job's persisted `createdAt`, and the
 * (optional) timezone shift is an explicit `offsetMinutes` input the CLI fills
 * from the machine's local offset. That keeps the whole thing deterministic and
 * trivially unit-testable.
 */

/** One hour-of-day bucket (0 = 00:00–00:59, … 23 = 23:00–23:59). */
export interface HourBucket {
  /** Hour of day, 0–23, in the report's (optionally shifted) time zone. */
  hour: number;
  /** Number of jobs whose `createdAt` falls in this hour. */
  count: number;
}

/** The full hour-of-day distribution over a job list. */
export interface HourlyActivity {
  /** Jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Jobs with a parseable `createdAt` that were placed in a bucket. */
  counted: number;
  /** Jobs skipped because their `createdAt` was missing or unparseable. */
  skipped: number;
  /**
   * Minutes added to UTC to reach the report's time zone (e.g. -420 for
   * UTC−07:00). 0 means the buckets are in UTC. Echoed so a JSON consumer knows
   * how the hours were computed.
   */
  offsetMinutes: number;
  /** Exactly 24 buckets, hour 0 → 23, always present (zero-filled). */
  hours: HourBucket[];
  /** The hour with the most jobs, or null when nothing was counted. */
  peakHour: number | null;
  /** The count in {@link peakHour}, or 0 when nothing was counted. */
  peakCount: number;
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 24 * 60;

/** Options for {@link computeHourlyActivity}. */
export interface HourlyActivityOptions {
  /**
   * Minutes to add to UTC before bucketing, so the histogram reads in a chosen
   * time zone. Defaults to 0 (UTC). Non-finite values are treated as 0. The
   * value is normalized into the same day so any offset lands on a valid hour.
   */
  offsetMinutes?: number;
}

/**
 * Buckets a job list by the hour of day its `createdAt` falls in. Pure and
 * non-mutating: no I/O, no ambient clock. Jobs whose `createdAt` is missing or
 * unparseable are counted in `skipped` (never silently dropped from the totals)
 * so a consumer can tell whether the picture is complete.
 *
 * The 24 buckets are always present and zero-filled, so callers can render a
 * full clock without guarding for gaps. `peakHour` breaks ties toward the
 * earliest hour, matching the left-to-right reading order of the rendered bars.
 */
export function computeHourlyActivity(jobs: RelayJob[], options: HourlyActivityOptions = {}): HourlyActivity {
  const rawOffset = options.offsetMinutes;
  const offsetMinutes = typeof rawOffset === "number" && Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : 0;

  const hours: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  let counted = 0;
  let skipped = 0;

  for (const jobItem of jobs) {
    const epoch = Date.parse(jobItem.createdAt);
    if (Number.isNaN(epoch)) {
      skipped += 1;
      continue;
    }
    // Shift into the report's time zone, then read the hour from the shifted
    // instant. `% MINUTES_PER_DAY` with a floored positive remainder keeps any
    // offset (including large or negative ones) on a valid 0–23 hour.
    const shifted = new Date(epoch + offsetMinutes * MS_PER_MINUTE);
    const minuteOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
    const normalized = ((minuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    const hour = Math.floor(normalized / 60);
    hours[hour].count += 1;
    counted += 1;
  }

  let peakHour: number | null = null;
  let peakCount = 0;
  for (const bucket of hours) {
    if (bucket.count > peakCount) {
      peakCount = bucket.count;
      peakHour = bucket.hour;
    }
  }

  return {
    total: jobs.length,
    counted,
    skipped,
    offsetMinutes,
    hours,
    peakHour,
    peakCount,
  };
}
