import type { RelayJob } from "./types.js";

/**
 * "When do my usage limits actually reset?" analytics for `agentrelay resets`.
 *
 * AgentRelay's whole job is knowing when a rate limit frees up, so the single
 * most planning-relevant fact hidden in the queue is the *time of day* those
 * resets land at: if your limit almost always reopens around 09:00 and 14:00,
 * you can schedule the heavy work to start just after. Neither `stats` (totals),
 * `patterns` (which message format), nor `trend` (per-day volume) answers this —
 * they all collapse the clock. This module bins reset instants into a 24-hour
 * histogram so the shape is visible at a glance.
 *
 * Everything here is pure (jobs + an injected timezone choice in, summary out):
 * no filesystem, no ambient clock. The hour is read in UTC by default (matching
 * `computeDailyTrend`) or in the host's local time when asked.
 */

/** One hour-of-day bucket (0–23) and how many reset instants fell in it. */
export interface ResetHourBucket {
  /** Hour of day, 0–23, in the summary's {@link ResetClockSummary.timeZone}. */
  hour: number;
  /** Number of jobs whose reset instant falls in this hour. */
  count: number;
}

/** Fleet-wide distribution of reset instants across the 24 hours of a day. */
export interface ResetClockSummary {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Jobs that carried a usable (parseable) reset instant and were binned. */
  withReset: number;
  /** Jobs with no usable reset instant (never rate-limited, or unparseable). */
  withoutReset: number;
  /** Which clock the `hour` values are expressed in. */
  timeZone: "utc" | "local";
  /**
   * Exactly 24 buckets, index === `hour`, ordered 0→23. Hours with no resets
   * are kept (count 0) so the histogram is a full day and gaps are visible.
   */
  buckets: ResetHourBucket[];
  /**
   * The hour with the most resets (ties broken by earliest hour), or null when
   * no job carried a usable reset instant. The "plan around this" headline.
   */
  peakHour: number | null;
}

/**
 * The reset instant to bin for a job. Prefers the persisted detection
 * provenance (`lastRateLimit.resetAt`) because it survives after the job leaves
 * `waiting_for_reset` — a completed/cancelled job still tells us *when* its
 * limit had reset. Falls back to the live `job.resetAt` for jobs parked before
 * provenance was recorded (or by a pre-provenance store). Returns null when
 * neither is present or parseable. Exported for direct testing.
 */
export function jobResetInstant(job: RelayJob): string | null {
  const fromDetection = job.lastRateLimit?.resetAt;
  if (typeof fromDetection === "string" && !Number.isNaN(Date.parse(fromDetection))) {
    return fromDetection;
  }
  if (typeof job.resetAt === "string" && !Number.isNaN(Date.parse(job.resetAt))) {
    return job.resetAt;
  }
  return null;
}

export interface ResetClockOptions {
  /** Bin the hour in the host's local time instead of UTC. Defaults to UTC. */
  local?: boolean;
}

/**
 * Bin every job's reset instant into a 24-hour histogram. Pure and
 * non-mutating: no I/O, no ambient clock — the hour comes only from each job's
 * own reset timestamp, read in UTC (default) or local time.
 *
 * A job contributes when {@link jobResetInstant} yields a parseable ISO
 * timestamp; anything else is counted as `withoutReset` rather than distorting
 * a bucket. The returned `buckets` array always has 24 entries (hours 0–23),
 * even when some are empty, so callers can render a full day without gap-filling.
 */
export function computeResetClock(jobs: RelayJob[], options: ResetClockOptions = {}): ResetClockSummary {
  const local = options.local ?? false;
  const counts = new Array<number>(24).fill(0);
  let withReset = 0;

  for (const job of jobs) {
    const iso = jobResetInstant(job);
    if (iso === null) continue;
    const date = new Date(iso);
    const hour = local ? date.getHours() : date.getUTCHours();
    counts[hour] += 1;
    withReset += 1;
  }

  const buckets: ResetHourBucket[] = counts.map((count, hour) => ({ hour, count }));

  let peakHour: number | null = null;
  if (withReset > 0) {
    let best = 0;
    for (let hour = 1; hour < 24; hour++) {
      if (counts[hour] > counts[best]) best = hour;
    }
    peakHour = best;
  }

  return {
    total: jobs.length,
    withReset,
    withoutReset: jobs.length - withReset,
    timeZone: local ? "local" : "utc",
    buckets,
    peakHour,
  };
}
