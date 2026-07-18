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
