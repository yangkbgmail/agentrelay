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

/** One hour-of-day slot in a {@link computeHourlyTrend} activity histogram. */
export interface HourlyActivity {
  /** Hour of day, 0–23 (UTC). */
  hour: number;
  /** Jobs created during this hour-of-day (bucketed by `createdAt`, UTC). */
  count: number;
}

/**
 * Buckets jobs by the UTC hour-of-day (0–23) they were created, aggregating
 * across every day in the store. Where `computeDailyTrend` answers "which days
 * were busy", this answers "which hours of the day do rate-limits pile up" —
 * useful for spotting a recurring daily window (e.g. a nightly batch that keeps
 * hitting the cap). Pure and non-mutating: no ambient clock, no I/O.
 *
 * The result is always exactly 24 entries, hour 0 → 23, zero-filled for quiet
 * hours so the histogram has a stable shape. Jobs with a missing or unparseable
 * `createdAt` are skipped — they can't be placed on the clock. Timezone matches
 * `--trend` (UTC) so the two histograms line up on the same clock.
 */
export function computeHourlyTrend(jobs: RelayJob[]): HourlyActivity[] {
  const counts = new Array<number>(24).fill(0);
  for (const job of jobs) {
    const created = Date.parse(job.createdAt);
    if (Number.isNaN(created)) continue;
    const hour = new Date(created).getUTCHours();
    counts[hour] += 1;
  }
  return counts.map((count, hour) => ({ hour, count }));
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
    };
  } else {
    // Sort once ascending; percentiles read from it, min/max are its ends.
    const sorted = [...resolutionDurations].sort((a, b) => a - b);
    timing = {
      resolvedCount,
      avgResolutionMs: Math.round(sorted.reduce((sum, d) => sum + d, 0) / resolvedCount),
      minResolutionMs: sorted[0],
      maxResolutionMs: sorted[resolvedCount - 1],
      medianResolutionMs: percentile(sorted, 0.5),
      p90ResolutionMs: percentile(sorted, 0.9),
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
