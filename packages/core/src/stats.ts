import { summarizeJobs } from "./summary.js";
import type { AgentTool, JobStatus, RelayJob } from "./types.js";

/** Statuses where the relay is still (or about to be) working the job. */
export const ACTIVE_STATUSES: JobStatus[] = ["queued", "waiting_for_reset", "resuming"];
/** Statuses where the job has reached a final state. */
export const TERMINAL_STATUSES: JobStatus[] = ["completed", "failed", "cancelled"];
/** Every known agent tool, so `byTool` always has a stable, zero-filled shape. */
export const ALL_TOOLS: AgentTool[] = ["claude-code", "codex-cli", "generic"];

export interface ProjectStat {
  project: string;
  count: number;
}

/**
 * Timing metrics over relay-resolved jobs (completed + failed). "Resolution
 * time" is a job's lifecycle span `updatedAt - createdAt`: how long the relay
 * babysat it, from the first rate-limit/queue to its natural terminal state.
 * Cancelled jobs are excluded (a user cut, not a relay-driven resolution),
 * mirroring how `successRate` treats them. Jobs with a missing/unparseable
 * timestamp or a negative span (clock skew) are skipped, not clamped.
 */
export interface TimingStats {
  /** Number of resolved jobs that contributed a valid, non-negative duration. */
  resolvedCount: number;
  /** Mean resolution time (ms) over {@link resolvedCount} jobs, or null when none. */
  avgResolutionMs: number | null;
  /** Shortest resolution time (ms), or null when none. */
  minResolutionMs: number | null;
  /** Longest resolution time (ms), or null when none. */
  maxResolutionMs: number | null;
  /**
   * Median (p50) resolution time (ms), or null when none. The average is easily
   * skewed by one long-babysat job; the median shows the typical case.
   */
  medianResolutionMs: number | null;
  /**
   * 90th-percentile resolution time (ms), or null when none. The tail matters
   * for a relay: it's the near-worst-case time a job sat before resolving.
   */
  p90ResolutionMs: number | null;
  /**
   * 95th-percentile resolution time (ms), or null when none. Beyond p90 the tail
   * can still hide slow outliers; p95 is the standard "how bad does it get for
   * all but the worst 5%?" latency marker.
   */
  p95ResolutionMs: number | null;
  /**
   * 99th-percentile resolution time (ms), or null when none. The worst-case tail:
   * with only a handful of resolved jobs this equals the max, but over a large
   * history it isolates the pathological long-babysat jobs the mean/p90 mask.
   */
  p99ResolutionMs: number | null;
  /**
   * 25th-percentile (lower quartile) resolution time (ms), or null when none.
   * The bottom of the "typical middle" — a quarter of resolutions were faster.
   */
  p25ResolutionMs: number | null;
  /**
   * 75th-percentile (upper quartile) resolution time (ms), or null when none.
   * The top of the "typical middle" — a quarter of resolutions were slower.
   */
  p75ResolutionMs: number | null;
  /**
   * Interquartile range (ms): p75 − p25, or null when none. A robust measure of
   * spread — the width of the middle 50% of resolutions, unaffected by the one
   * pathological outlier that inflates the standard deviation. A small IQR next
   * to a large max says "usually consistent, with rare long tails".
   */
  iqrResolutionMs: number | null;
  /**
   * Median absolute deviation of resolution times (ms), or null when none: the
   * median of each span's absolute distance from the median span. The most
   * outlier-resistant spread measure here — where {@link stdevResolutionMs}
   * squares deviations (so one pathological long-babysat job dominates) and even
   * {@link iqrResolutionMs} depends on the exact p25/p75 samples, the MAD stays
   * put unless *half* the resolutions move. A MAD far below the stdev is the
   * clearest signal that the queue is usually consistent with rare heavy tails.
   */
  madResolutionMs: number | null;
  /**
   * Population standard deviation of resolution times (ms), or null when none.
   * The classic spread measure: how far resolutions typically stray from the
   * mean. Read alongside {@link iqrResolutionMs} — a stdev much larger than the
   * IQR is the signature of a few heavy outliers dragging the mean.
   */
  stdevResolutionMs: number | null;
  /**
   * Coefficient of variation: population stdev ÷ mean, a dimensionless ratio of
   * relative dispersion, or null when none (or when the mean is 0). Unlike the
   * absolute-ms {@link stdevResolutionMs}, CV is scale-free — it answers "how
   * variable are resolutions *relative to their own average*", so a queue whose
   * jobs resolve in minutes and one whose jobs resolve in hours are directly
   * comparable. Rule of thumb: < 0.5 tight, ~1 spread on the order of the mean,
   * > 1 heavy-tailed. Rounded to 4 decimals.
   */
  cvResolution: number | null;
}

export interface RelayStats {
  total: number;
  /** Count per job status (all statuses present, zero-filled). */
  byStatus: Record<JobStatus, number>;
  /** Count per agent tool (all tools present, zero-filled). */
  byTool: Record<AgentTool, number>;
  /** Jobs the relay is still working (queued + waiting_for_reset + resuming). */
  active: number;
  /** Jobs in a final state (completed + failed + cancelled). */
  terminal: number;
  /**
   * completed / (completed + failed), in [0, 1]. Cancelled jobs are excluded —
   * a user-initiated cancel is neither a relay success nor a relay failure.
   * `null` when nothing has resolved yet (avoids a misleading 0%).
   */
  successRate: number | null;
  /** Total resume attempts summed across every job. */
  totalAttempts: number;
  /** Jobs that were resumed more than once (attempts > 1) — i.e. actually relayed. */
  retriedJobs: number;
  /** Earliest reset time among jobs still waiting, or null when none wait. */
  nextResetAt: string | null;
  /** Projects ranked by job count (desc), ties broken by name (asc). */
  projects: ProjectStat[];
  /** Resolution-time metrics over completed + failed jobs. */
  timing: TimingStats;
}

/**
 * A subset selector for {@link scopeJobs}: keep only jobs matching every
 * supplied dimension (AND across dimensions, OR within one). An omitted or
 * empty list for a dimension means "don't filter on it".
 */
export interface JobScope {
  /** Keep only jobs whose status is one of these. */
  statuses?: JobStatus[];
  /** Keep only jobs whose tool is one of these (matched as raw strings). */
  tools?: string[];
  /** Keep only jobs whose project is one of these (exact match). */
  projects?: string[];
  /**
   * Keep only jobs created at-or-after this epoch-ms boundary (inclusive). An
   * explicit timestamp, not a clock/duration, so `scopeJobs` stays pure and
   * testable. `agentrelay stats --since 24h` computes `now - 24h` and passes it
   * here. Jobs whose `createdAt` is missing/unparseable can't be placed on the
   * timeline, so they're dropped whenever a time bound is active.
   */
  createdFrom?: number;
  /** Keep only jobs created at-or-before this epoch-ms boundary (inclusive). */
  createdTo?: number;
}

/** True when a scope would actually filter anything (any dimension is set). */
export function isJobScopeActive(scope: JobScope): boolean {
  return Boolean(
    (scope.statuses && scope.statuses.length > 0) ||
      (scope.tools && scope.tools.length > 0) ||
      (scope.projects && scope.projects.length > 0) ||
      scope.createdFrom !== undefined ||
      scope.createdTo !== undefined
  );
}

/**
 * Narrows a job list to those matching a {@link JobScope}, so `agentrelay stats`
 * can report metrics for just a project, tool, or status subset. Pure and
 * non-mutating: returns a fresh array (a shallow copy even when nothing filters)
 * so callers never alias the store. Tools are matched as raw strings — an
 * unknown tool string still filters correctly rather than being silently coerced.
 */
export function scopeJobs(jobs: RelayJob[], scope: JobScope = {}): RelayJob[] {
  let result = jobs.slice();
  if (scope.statuses && scope.statuses.length > 0) {
    const wanted = new Set<JobStatus>(scope.statuses);
    result = result.filter((job) => wanted.has(job.status));
  }
  if (scope.tools && scope.tools.length > 0) {
    const wanted = new Set<string>(scope.tools);
    result = result.filter((job) => wanted.has(job.tool));
  }
  if (scope.projects && scope.projects.length > 0) {
    const wanted = new Set<string>(scope.projects);
    result = result.filter((job) => wanted.has(job.project));
  }
  if (scope.createdFrom !== undefined || scope.createdTo !== undefined) {
    const from = scope.createdFrom ?? Number.NEGATIVE_INFINITY;
    const to = scope.createdTo ?? Number.POSITIVE_INFINITY;
    result = result.filter((job) => {
      const created = Date.parse(job.createdAt);
      // Unplaceable jobs (missing/unparseable createdAt) drop out of a windowed
      // scope rather than silently counting toward every window.
      if (Number.isNaN(created)) return false;
      return created >= from && created <= to;
    });
  }
  return result;
}

/** Milliseconds in a UTC calendar day. Epoch day boundaries are UTC-aligned. */
const DAY_MS = 86_400_000;

/** One day's slot in a {@link computeDailyTrend} activity histogram. */
export interface DailyActivity {
  /** UTC calendar day, "YYYY-MM-DD". */
  date: string;
  /** Jobs created on this day (bucketed by `createdAt`, UTC). */
  count: number;
}

/** UTC midnight (epoch ms) of the day containing `ms`. */
function utcDayStart(ms: number): number {
  // Epoch 0 is 1970-01-01T00:00:00Z and DAY_MS divides the epoch evenly, so
  // flooring to a day boundary yields UTC midnight with no timezone math.
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** "YYYY-MM-DD" for a UTC-midnight epoch ms. */
function utcDateKey(dayStartMs: number): string {
  return new Date(dayStartMs).toISOString().slice(0, 10);
}

/**
 * Buckets jobs by the UTC calendar day they were created, over the last `days`
 * days ending on the day of `nowMs` (inclusive), so `agentrelay stats --trend`
 * can show when rate-limits actually piled up. Pure and non-mutating: the day
 * window is derived from the injected `nowMs`, never an ambient clock.
 *
 * The result is always exactly `days` entries, oldest first, zero-filled for
 * quiet days so the histogram has a stable shape. Jobs with a missing or
 * unparseable `createdAt`, or one that falls outside the window, are skipped —
 * they can't be placed on the timeline. `days` is clamped to at least 1.
 */
export function computeDailyTrend(jobs: RelayJob[], options: { nowMs: number; days: number }): DailyActivity[] {
  const days = Math.max(1, Math.floor(options.days));
  const todayStart = utcDayStart(options.nowMs);
  const windowStart = todayStart - (days - 1) * DAY_MS;

  const counts = new Map<string, number>();
  for (const job of jobs) {
    const created = Date.parse(job.createdAt);
    if (Number.isNaN(created)) continue;
    const dayStart = utcDayStart(created);
    if (dayStart < windowStart || dayStart > todayStart) continue;
    const key = utcDateKey(dayStart);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const trend: DailyActivity[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = utcDateKey(todayStart - i * DAY_MS);
    trend.push({ date: key, count: counts.get(key) ?? 0 });
  }
  return trend;
}

export interface HourlyActivity {
  /** Hour of day, 0–23, in the requested zone (UTC unless an offset is given). */
  hour: number;
  /** Jobs whose `createdAt` falls in this hour, across every day. */
  count: number;
}

/**
 * Buckets jobs by the hour-of-day (0–23) they were created in, aggregated
 * across every day in the store, so `agentrelay stats --hours` can show which
 * hours rate-limits tend to cluster in ("I mostly get throttled around 15:00").
 * Unlike {@link computeDailyTrend} this has no window and needs no clock:
 * hour-of-day is an absolute property of each timestamp.
 *
 * `offsetMinutes` shifts each timestamp before the hour is read, so callers can
 * bucket by a local wall clock instead of UTC (e.g. `540` for UTC+09:00). It
 * defaults to `0` (UTC), keeping the pure/testable contract — the caller passes
 * the zone offset explicitly rather than the function reading the machine clock.
 *
 * The result is always exactly 24 entries, hour 0 through hour 23, zero-filled
 * for quiet hours so the histogram has a stable shape. Jobs with a missing or
 * unparseable `createdAt` are skipped — they can't be placed on the clock.
 */
export function computeHourlyDistribution(jobs: RelayJob[], offsetMinutes = 0): HourlyActivity[] {
  const counts = new Array<number>(24).fill(0);
  const shiftMs = offsetMinutes * 60_000;
  for (const job of jobs) {
    const created = Date.parse(job.createdAt);
    if (Number.isNaN(created)) continue;
    counts[new Date(created + shiftMs).getUTCHours()] += 1;
  }
  return counts.map((count, hour) => ({ hour, count }));
}

/** Weekday names, indexed by `Date.getUTCDay()` (0 = Sunday … 6 = Saturday). */
export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface WeekdayActivity {
  /** Day of week, 0 (Sunday) – 6 (Saturday), in the requested zone. */
  weekday: number;
  /** Short weekday name (`Sun`…`Sat`), taken from {@link WEEKDAY_NAMES}. */
  name: string;
  /** Jobs whose `createdAt` falls on this weekday, across every week. */
  count: number;
}

/**
 * Buckets jobs by the day-of-week (0 = Sunday … 6 = Saturday) they were created
 * on, aggregated across every week in the store, so `agentrelay stats --weekday`
 * can show which weekdays rate-limits tend to cluster on ("I mostly get
 * throttled on Mondays"). Like {@link computeHourlyDistribution} this has no
 * window and needs no clock: day-of-week is an absolute property of the
 * timestamp.
 *
 * `offsetMinutes` shifts each timestamp before the weekday is read, so callers
 * can bucket by a local wall clock instead of UTC (e.g. `540` for UTC+09:00) —
 * a job created just after UTC midnight can land on the previous local day. It
 * defaults to `0` (UTC), keeping the pure/testable contract.
 *
 * The result is always exactly 7 entries, Sunday through Saturday, zero-filled
 * for quiet days so the histogram has a stable shape. Jobs with a missing or
 * unparseable `createdAt` are skipped — they can't be placed on the calendar.
 */
export function computeWeekdayDistribution(jobs: RelayJob[], offsetMinutes = 0): WeekdayActivity[] {
  const counts = new Array<number>(7).fill(0);
  const shiftMs = offsetMinutes * 60_000;
  for (const job of jobs) {
    const created = Date.parse(job.createdAt);
    if (Number.isNaN(created)) continue;
    counts[new Date(created + shiftMs).getUTCDay()] += 1;
  }
  return counts.map((count, weekday) => ({ weekday, name: WEEKDAY_NAMES[weekday], count }));
}

export interface ActivityHeatmap {
  /**
   * Job counts as a 7×24 grid: `cells[weekday][hour]`, where `weekday` is the
   * UTC day of week (0 = Sunday … 6 = Saturday, matching `Date.getUTCDay()`) and
   * `hour` is the UTC hour of day (0–23). Always fully allocated (7 rows × 24
   * columns), zero-filled for empty cells so the grid has a stable shape.
   */
  cells: number[][];
  /** Total jobs placed on the grid (excludes skipped/unparseable timestamps). */
  total: number;
  /** The busiest single cell's count (0 when the grid is empty). */
  maxCell: number;
}

/**
 * Buckets jobs into a UTC weekday × hour-of-day grid so `agentrelay stats
 * --heatmap` can show *when in the week* rate-limits cluster — the two axes of
 * {@link computeWeekdayDistribution} (day of week) and
 * {@link computeHourlyDistribution} (hour of day) combined into one view
 * ("I mostly get throttled Monday mornings"). Like those two it has no window
 * and needs no clock: both coordinates are absolute properties of the timestamp.
 *
 * `offsetMinutes` shifts each timestamp before the weekday/hour are read, so
 * callers can bucket by a local wall clock instead of UTC (e.g. `540` for
 * UTC+09:00), matching {@link computeHourlyDistribution} /
 * {@link computeWeekdayDistribution}. It defaults to `0` (UTC), keeping the
 * pure/testable contract — the caller passes the offset rather than the
 * function reading the machine clock.
 *
 * The grid is always exactly 7 rows (Sun–Sat) × 24 columns (hour 0–23),
 * zero-filled for quiet cells. Jobs with a missing or unparseable `createdAt`
 * are skipped — they can't be placed on the calendar.
 */
export function computeActivityHeatmap(jobs: RelayJob[], offsetMinutes = 0): ActivityHeatmap {
  const cells: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const shiftMs = offsetMinutes * 60_000;
  let total = 0;
  let maxCell = 0;
  for (const job of jobs) {
    const created = Date.parse(job.createdAt);
    if (Number.isNaN(created)) continue;
    const date = new Date(created + shiftMs);
    const next = cells[date.getUTCDay()][date.getUTCHours()] + 1;
    cells[date.getUTCDay()][date.getUTCHours()] = next;
    if (next > maxCell) maxCell = next;
    total += 1;
  }
  return { cells, total, maxCell };
}

/** Statuses whose lifecycle span counts as a relay-driven resolution. */
const RESOLVED_STATUSES: JobStatus[] = ["completed", "failed"];

/**
 * Lifecycle span of a job in ms (`updatedAt - createdAt`), or null when either
 * timestamp is missing/unparseable or the span is negative (clock skew).
 */
function resolutionMs(job: RelayJob): number | null {
  const created = Date.parse(job.createdAt);
  const updated = Date.parse(job.updatedAt);
  if (Number.isNaN(created) || Number.isNaN(updated)) return null;
  const span = updated - created;
  return span >= 0 ? span : null;
}

/**
 * Linear-interpolated percentile (0..1) over an ascending-sorted, non-empty
 * array. p=0.5 → median, p=0.9 → p90. Matches the common "type 7" / NumPy
 * default: rank = p·(n−1), interpolate between the two straddling samples.
 * Result is rounded to whole ms. Callers guarantee `sortedAsc.length > 0`.
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
 * Population standard deviation (not sample) over a non-empty list, rounded to
 * whole ms. Population is the right choice here: `values` is the complete set of
 * resolved-job spans being described, not a sample drawn to infer a wider
 * population. A single value yields 0 (no spread). Callers guarantee non-empty.
 */
function populationStdev(values: number[], mean: number): number {
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.round(Math.sqrt(variance));
}

/**
 * Median absolute deviation (ms) over a non-empty, ascending-sorted list, given
 * its already-computed `median`: the median of each value's absolute distance
 * from that median. A robust dispersion measure — unlike the standard deviation
 * it isn't inflated by a single extreme outlier, since it summarizes the *typical*
 * deviation, not the squared one. A single value yields 0 (no spread). Rounded to
 * whole ms (the deviations feed the same `percentile` helper). Non-empty input.
 */
function medianAbsoluteDeviation(sortedAsc: number[], median: number): number {
  const deviations = sortedAsc.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  return percentile(deviations, 0.5);
}

/**
 * Coefficient of variation: population stdev ÷ mean, rounded to 4 decimals.
 * Returns null when the mean is 0 — for non-negative spans a zero mean means
 * every span was 0, so the ratio is undefined (0/0) rather than 0. Uses the
 * unrounded stdev so ms-level rounding never distorts the ratio. Non-empty input.
 */
function coefficientOfVariation(values: number[], mean: number): number | null {
  if (mean === 0) return null;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.round((Math.sqrt(variance) / mean) * 10_000) / 10_000;
}

/**
 * Aggregates a job list into headline relay metrics for `agentrelay stats`.
 * Pure and non-mutating: no I/O, no ambient clock. Reuses {@link summarizeJobs}
 * for the per-status counts and next-reset so the two surfaces never drift.
 */
export function computeStats(jobs: RelayJob[]): RelayStats {
  const { total, byStatus, nextResetAt } = summarizeJobs(jobs);

  const byTool = Object.fromEntries(ALL_TOOLS.map((t) => [t, 0])) as Record<AgentTool, number>;
  const projectCounts = new Map<string, number>();
  let totalAttempts = 0;
  let retriedJobs = 0;
  const resolutionDurations: number[] = [];

  for (const job of jobs) {
    // A job may carry a tool we don't statically know about; only bump known
    // tools so the zero-filled shape stays honest instead of inventing keys.
    if (job.tool in byTool) byTool[job.tool] += 1;
    totalAttempts += job.attempts;
    if (job.attempts > 1) retriedJobs += 1;
    projectCounts.set(job.project, (projectCounts.get(job.project) ?? 0) + 1);
    if (RESOLVED_STATUSES.includes(job.status)) {
      const span = resolutionMs(job);
      if (span !== null) resolutionDurations.push(span);
    }
  }

  const active = ACTIVE_STATUSES.reduce((sum, s) => sum + byStatus[s], 0);
  const terminal = TERMINAL_STATUSES.reduce((sum, s) => sum + byStatus[s], 0);

  const resolved = byStatus.completed + byStatus.failed;
  const successRate = resolved === 0 ? null : byStatus.completed / resolved;

  const projects = [...projectCounts.entries()]
    .map(([project, count]) => ({ project, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.project.localeCompare(b.project)));

  const resolvedCount = resolutionDurations.length;
  let timing: TimingStats;
  if (resolvedCount === 0) {
    timing = {
      resolvedCount: 0,
      avgResolutionMs: null,
      minResolutionMs: null,
      maxResolutionMs: null,
      medianResolutionMs: null,
      p90ResolutionMs: null,
      p95ResolutionMs: null,
      p99ResolutionMs: null,
      p25ResolutionMs: null,
      p75ResolutionMs: null,
      iqrResolutionMs: null,
      madResolutionMs: null,
      stdevResolutionMs: null,
      cvResolution: null,
    };
  } else {
    // Sort once ascending; percentiles read from it, min/max are its ends.
    const sorted = [...resolutionDurations].sort((a, b) => a - b);
    const mean = sorted.reduce((sum, d) => sum + d, 0) / resolvedCount;
    const p25 = percentile(sorted, 0.25);
    const p75 = percentile(sorted, 0.75);
    const median = percentile(sorted, 0.5);
    timing = {
      resolvedCount,
      avgResolutionMs: Math.round(mean),
      minResolutionMs: sorted[0],
      maxResolutionMs: sorted[resolvedCount - 1],
      medianResolutionMs: median,
      p90ResolutionMs: percentile(sorted, 0.9),
      p95ResolutionMs: percentile(sorted, 0.95),
      p99ResolutionMs: percentile(sorted, 0.99),
      p25ResolutionMs: p25,
      p75ResolutionMs: p75,
      iqrResolutionMs: p75 - p25,
      madResolutionMs: medianAbsoluteDeviation(sorted, median),
      stdevResolutionMs: populationStdev(sorted, mean),
      cvResolution: coefficientOfVariation(sorted, mean),
    };
  }

  return {
    total,
    byStatus,
    byTool,
    active,
    terminal,
    successRate,
    totalAttempts,
    retriedJobs,
    nextResetAt,
    projects,
    timing,
  };
}

/**
 * A dimension to split a job list on for {@link groupStats}. Each grouped subset
 * gets its own full {@link RelayStats}, so questions like "which project resolves
 * fastest?" or "which tool has the best success rate?" become answerable.
 */
export type GroupDimension = "tool" | "project" | "status";

/** Every dimension {@link groupStats} accepts, for CLI validation/help text. */
export const GROUP_DIMENSIONS: GroupDimension[] = ["tool", "project", "status"];

/** One group's key and its full aggregate stats. */
export interface GroupedStat {
  /** The shared dimension value for every job in this group. */
  key: string;
  /** How many jobs fall in this group (mirrors `stats.total`, kept for sort/UX). */
  count: number;
  /** Full relay metrics computed over just this group's jobs. */
  stats: RelayStats;
}

/** The raw job value used to bucket a job under a given dimension. */
function groupKeyOf(job: RelayJob, dimension: GroupDimension): string {
  switch (dimension) {
    case "tool":
      return job.tool;
    case "project":
      return job.project;
    case "status":
      return job.status;
  }
}

/**
 * Partitions a job list by `dimension` and computes a full {@link RelayStats}
 * for each partition, so `agentrelay stats --group-by project|tool|status` can
 * show a per-group breakdown. Pure and non-mutating. Groups are ranked by job
 * count (desc), ties broken by key (asc) — same ordering convention as
 * `RelayStats.projects`. Insertion into buckets preserves each job's original
 * order so per-group timing/percentiles are deterministic.
 */
export function groupStats(jobs: RelayJob[], dimension: GroupDimension): GroupedStat[] {
  const buckets = new Map<string, RelayJob[]>();
  for (const job of jobs) {
    const key = groupKeyOf(job, dimension);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(job);
    else buckets.set(key, [job]);
  }
  return [...buckets.entries()]
    .map(([key, groupJobs]) => ({ key, count: groupJobs.length, stats: computeStats(groupJobs) }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.key.localeCompare(b.key)));
}
