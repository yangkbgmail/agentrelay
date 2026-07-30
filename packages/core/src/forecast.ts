import type { AgentTool, RelayJob } from "./types.js";

/**
 * Resume forecast for `agentrelay forecast` — a chronological "when will my
 * queue drain?" view. `agentrelay next` answers about the *single* soonest
 * resume and `agentrelay status --sort reset` lists jobs, but neither buckets
 * the waiting work by time-until-reset or tells you when the *last* job comes
 * due. This module does: it groups every `waiting_for_reset` job into time
 * horizons (due now, within 1h, …) so a maintainer can see the shape of the
 * upcoming workload at a glance.
 *
 * Pure and non-mutating: the only ambient input is `now` (epoch ms), injected
 * for deterministic tests. Jobs that aren't parked for a reset — or whose
 * `resetAt` won't parse — simply don't appear in the forecast.
 */

/** One upcoming resume, derived from a `waiting_for_reset` job. */
export interface ResumeEvent {
  /** The waiting job's id. */
  jobId: string;
  /** Its project label. */
  project: string;
  /** The agent tool that will be re-spawned. */
  tool: AgentTool;
  /** ISO reset time (guaranteed parseable — unparseable jobs are dropped). */
  resetAt: string;
  /** Milliseconds from `now` until the reset; zero/negative once it has passed. */
  dueInMs: number;
  /** True once the reset time has passed — a scheduler tick would pick it up now. */
  due: boolean;
}

/** A named time horizon and the resume events that fall inside it. */
export interface ForecastBucket {
  /** Stable machine key (e.g. "overdue", "1h"). */
  key: string;
  /** Human label (e.g. "due now", "within 1h"). */
  label: string;
  /**
   * Inclusive upper bound on `dueInMs` for this bucket (ms), or null for the
   * unbounded catch-all ("later"). An event lands in the first bucket whose
   * bound it satisfies.
   */
  upperMs: number | null;
  /** Number of events in this bucket. */
  count: number;
  /** The events themselves, soonest reset first. */
  events: ResumeEvent[];
}

/** Specification of one forecast horizon (before events are assigned). */
export interface ForecastBucketSpec {
  key: string;
  label: string;
  /** Inclusive upper bound on `dueInMs` (ms); null = unbounded catch-all. */
  upperMs: number | null;
}

const HOUR_MS = 60 * 60_000;

/**
 * Default horizons, ordered soonest → latest. The first bucket (upperMs 0)
 * captures overdue/due-now events (`dueInMs <= 0`); the last (upperMs null) is
 * the unbounded catch-all. An event is placed in the first spec whose
 * `upperMs` is null or `>= dueInMs`.
 */
export const DEFAULT_FORECAST_BUCKETS: ForecastBucketSpec[] = [
  { key: "overdue", label: "due now", upperMs: 0 },
  { key: "1h", label: "within 1h", upperMs: HOUR_MS },
  { key: "6h", label: "within 6h", upperMs: 6 * HOUR_MS },
  { key: "24h", label: "within 24h", upperMs: 24 * HOUR_MS },
  { key: "later", label: "later", upperMs: null },
];

/** The full resume forecast returned by {@link computeResumeForecast}. */
export interface ResumeForecast {
  /** `now` (epoch ms) the forecast was computed against. */
  now: number;
  /** Total resume events (waiting jobs with a parseable `resetAt`). */
  waiting: number;
  /** How many of those are already due (`dueInMs <= 0`). */
  overdue: number;
  /** Earliest reset (ISO) among waiting jobs, or null when none wait. */
  nextResetAt: string | null;
  /**
   * Latest reset (ISO) among waiting jobs — when the queue would fully drain if
   * nothing new is queued — or null when none wait.
   */
  lastResetAt: string | null;
  /** Time horizons with their assigned events (empty buckets are kept). */
  buckets: ForecastBucket[];
  /** Every resume event, soonest reset first (flattened across buckets). */
  events: ResumeEvent[];
}

/**
 * Orders two resume events by which the scheduler resumes first: earliest reset
 * wins, then oldest `createdAt`, then id — fully deterministic even when two
 * jobs share a reset time. Mirrors the tiebreak in `selectNextResume`.
 */
function compareEvents(a: ResumeEvent, b: ResumeEvent): number {
  if (a.dueInMs !== b.dueInMs) return a.dueInMs - b.dueInMs;
  if (a.jobId === b.jobId) return 0;
  return a.jobId < b.jobId ? -1 : 1;
}

/**
 * Builds a resume forecast from a job list. Only `waiting_for_reset` jobs with
 * a parseable `resetAt` participate; each becomes a {@link ResumeEvent}, sorted
 * soonest-first and bucketed into the given time horizons (defaulting to
 * {@link DEFAULT_FORECAST_BUCKETS}). Pure: no I/O, no ambient clock — `now`
 * defaults to `Date.now()` only when omitted.
 */
export function computeResumeForecast(
  jobs: RelayJob[],
  options: { now?: number; buckets?: ForecastBucketSpec[] } = {}
): ResumeForecast {
  const now = options.now ?? Date.now();
  const specs = options.buckets ?? DEFAULT_FORECAST_BUCKETS;

  const events: ResumeEvent[] = [];
  for (const job of jobs) {
    if (job.status !== "waiting_for_reset" || job.resetAt === null) continue;
    const resetMs = Date.parse(job.resetAt);
    if (Number.isNaN(resetMs)) continue;
    const dueInMs = resetMs - now;
    events.push({
      jobId: job.id,
      project: job.project,
      tool: job.tool,
      resetAt: job.resetAt,
      dueInMs,
      due: dueInMs <= 0,
    });
  }

  events.sort(compareEvents);

  const buckets: ForecastBucket[] = specs.map((spec) => ({
    key: spec.key,
    label: spec.label,
    upperMs: spec.upperMs,
    count: 0,
    events: [],
  }));

  for (const event of events) {
    // First bucket whose bound the event satisfies. Falls back to the last
    // bucket if none matches (a misconfigured spec list with no catch-all).
    let target = buckets[buckets.length - 1];
    for (const bucket of buckets) {
      if (bucket.upperMs === null || event.dueInMs <= bucket.upperMs) {
        target = bucket;
        break;
      }
    }
    if (target) {
      target.count += 1;
      target.events.push(event);
    }
  }

  return {
    now,
    waiting: events.length,
    overdue: events.filter((e) => e.due).length,
    nextResetAt: events.length > 0 ? events[0].resetAt : null,
    lastResetAt: events.length > 0 ? events[events.length - 1].resetAt : null,
    buckets,
    events,
  };
}
