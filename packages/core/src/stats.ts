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

/**
 * A dimension to partition jobs by for a per-group stats breakdown. Answers
 * "which tool/project/status relays best?" — e.g. success rate per project.
 */
export type GroupDimension = "tool" | "project" | "status";

/** All group dimensions, for CLI validation and help text. */
export const GROUP_DIMENSIONS: GroupDimension[] = ["tool", "project", "status"];

/** One partition of a {@link groupStats} breakdown: a key plus its own metrics. */
export interface StatGroup {
  /** The dimension value shared by every job in this group (raw string). */
  key: string;
  /** Number of jobs in this group (mirrors `stats.total`, hoisted for sorting). */
  count: number;
  /** Full relay metrics computed over just this group's jobs. */
  stats: RelayStats;
}

/** Extract the grouping key for a job along a given dimension (raw string). */
function groupKey(job: RelayJob, dimension: GroupDimension): string {
  if (dimension === "tool") return job.tool;
  if (dimension === "status") return job.status;
  return job.project;
}

/**
 * Partitions a job list by `dimension` and computes full {@link RelayStats} for
 * each group, so `agentrelay stats --group-by project` can compare success
 * rates, retries, and resolution times across tools/projects/statuses. Pure and
 * non-mutating. Only dimension values actually present in `jobs` become groups
 * (an empty store yields `[]`) — the shape stays honest instead of inventing
 * zero rows. Groups are ordered by job count (desc), ties broken by key (asc),
 * matching how {@link computeStats} ranks projects.
 */
export function groupStats(jobs: RelayJob[], dimension: GroupDimension): StatGroup[] {
  const buckets = new Map<string, RelayJob[]>();
  // Preserve first-seen order for a stable tiebreak feed; the sort below makes
  // the final order deterministic regardless.
  for (const job of jobs) {
    const key = groupKey(job, dimension);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(job);
    else buckets.set(key, [job]);
  }
  return [...buckets.entries()]
    .map(([key, groupJobs]) => ({ key, count: groupJobs.length, stats: computeStats(groupJobs) }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.key.localeCompare(b.key)));
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
