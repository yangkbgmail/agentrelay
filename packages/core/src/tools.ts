import { ACTIVE_STATUSES } from "./stats.js";
import type { AgentTool, JobStatus, RelayJob } from "./types.js";

/**
 * Per-tool rollup for `agentrelay tools`. The `--tool` filter that
 * status/stats/export/cancel/retry/metrics/patterns/errors/projects all share
 * keys off `job.tool` (the adapter: claude-code / codex-cli / generic), but
 * nothing let you *discover* which tools actually appear in the store, or see
 * at a glance which one has work parked. This is the tool-axis sibling of
 * `agentrelay projects`: one row per distinct `job.tool`, with the counts and
 * timing a maintainer needs to decide where to look next.
 */
export interface ToolBreakdown {
  /** The agent tool label (from `job.tool`). */
  tool: AgentTool;
  /** Total jobs run with this tool (within any scope the caller applied). */
  total: number;
  /** Jobs still in-flight: queued + waiting_for_reset + resuming. */
  active: number;
  /** Jobs in a terminal state: completed + failed + cancelled. */
  terminal: number;
  /** Jobs specifically parked waiting for a rate-limit reset. */
  waiting: number;
  /**
   * Earliest `resetAt` (ISO) among this tool's `waiting_for_reset` jobs, or null
   * when none wait. Lets you spot which tool resumes soonest.
   */
  nextResetAt: string | null;
  /**
   * The most recent `updatedAt` (ISO) across this tool's jobs, or null when no
   * job has a usable timestamp — a rough "last touched" marker.
   */
  lastActivityAt: string | null;
}

/**
 * Fleet-wide tool index: total jobs considered, the number of distinct tools
 * present, and the per-tool breakdown ranked so the tool with the most pending
 * work floats to the top.
 */
export interface ToolsSummary {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Number of distinct tools present. */
  toolCount: number;
  /** Per-tool rows, ranked by active desc, then total desc, then tool asc. */
  tools: ToolBreakdown[];
}

const ACTIVE_SET = new Set<JobStatus>(ACTIVE_STATUSES);

/**
 * Groups a job list by `job.tool` into a per-tool breakdown for
 * `agentrelay tools`. Pure and non-mutating: no I/O, no ambient clock. Only
 * tools actually present in the input get a row (mirroring `summarizeProjects`,
 * which lists the labels that exist rather than a zero-filled enum) so that a
 * `--tool` scope narrows the report honestly. ISO timestamps are compared
 * lexically (they sort chronologically), matching how `summarizeJobs` already
 * picks the earliest `resetAt`; a missing/empty `resetAt` or `updatedAt` simply
 * doesn't participate in the min/max.
 *
 * Rows are ranked by `active` (desc) so a maintainer sees where work is pending
 * first, then by `total` (desc), then by tool name (asc) for a stable order.
 */
export function summarizeTools(jobs: RelayJob[]): ToolsSummary {
  const buckets = new Map<AgentTool, ToolBreakdown>();

  for (const job of jobs) {
    const tool = job.tool;
    let row = buckets.get(tool);
    if (!row) {
      row = {
        tool,
        total: 0,
        active: 0,
        terminal: 0,
        waiting: 0,
        nextResetAt: null,
        lastActivityAt: null,
      };
      buckets.set(tool, row);
    }

    row.total += 1;
    if (ACTIVE_SET.has(job.status)) row.active += 1;
    else row.terminal += 1;

    if (job.status === "waiting_for_reset") {
      row.waiting += 1;
      if (job.resetAt && (row.nextResetAt === null || job.resetAt < row.nextResetAt)) {
        row.nextResetAt = job.resetAt;
      }
    }

    if (job.updatedAt && (row.lastActivityAt === null || job.updatedAt > row.lastActivityAt)) {
      row.lastActivityAt = job.updatedAt;
    }
  }

  const tools = [...buckets.values()].sort((a, b) => {
    if (b.active !== a.active) return b.active - a.active;
    if (b.total !== a.total) return b.total - a.total;
    return a.tool.localeCompare(b.tool);
  });

  return {
    total: jobs.length,
    toolCount: tools.length,
    tools,
  };
}
