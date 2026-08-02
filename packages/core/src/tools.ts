import { ACTIVE_STATUSES } from "./stats.js";
import type { JobStatus, RelayJob } from "./types.js";

/**
 * Per-tool rollup for `agentrelay tools`. The `--tool` filter is threaded
 * through nearly every command (status/stats/export/cancel/retry/metrics/
 * patterns/errors), yet until now nothing let you *discover* which agent tools
 * (claude-code / codex-cli / generic, or any label a future adapter persists)
 * actually appear in the store, or see at a glance which one still has work
 * pending. This is the tool-dimension mirror of `agentrelay projects`: one row
 * per distinct `job.tool`, with the counts and timing a maintainer needs to
 * decide where to look next.
 */
export interface ToolBreakdown {
  /** The tool label (from `job.tool`; e.g. "claude-code"). */
  tool: string;
  /** Total jobs run with this tool (within any scope the caller applied). */
  total: number;
  /** Jobs still in-flight: queued + waiting_for_reset + resuming. */
  active: number;
  /** Jobs in a terminal state: completed + failed + cancelled. */
  terminal: number;
  /** Jobs specifically parked waiting for a rate-limit reset. */
  waiting: number;
  /**
   * Earliest `resetAt` (ISO) among this tool's `waiting_for_reset` jobs, or
   * null when none wait. Lets you spot which tool resumes soonest.
   */
  nextResetAt: string | null;
  /**
   * The most recent `updatedAt` (ISO) across this tool's jobs, or null when no
   * job has a usable timestamp — a rough "last touched" marker.
   */
  lastActivityAt: string | null;
}

/**
 * Fleet-wide tool index: total jobs considered, the number of distinct tool
 * labels, and the per-tool breakdown ranked so the tool with the most pending
 * work floats to the top.
 */
export interface ToolsSummary {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Number of distinct tool labels present. */
  toolCount: number;
  /** Per-tool rows, ranked by active desc, then total desc, then name asc. */
  tools: ToolBreakdown[];
}

const ACTIVE_SET = new Set<JobStatus>(ACTIVE_STATUSES);

/**
 * Groups a job list by `job.tool` into a per-tool breakdown for
 * `agentrelay tools`. Pure and non-mutating: no I/O, no ambient clock. ISO
 * timestamps are compared lexically (they sort chronologically), matching how
 * `summarizeProjects`/`summarizeJobs` already pick the earliest `resetAt`; a
 * missing/empty `resetAt` or `updatedAt` simply doesn't participate in the
 * min/max.
 *
 * Only tools that actually appear in the input get a row (discovery of what's
 * really in the store), and rows are ranked by `active` (desc) so a maintainer
 * sees where work is pending first, then by `total` (desc), then by tool name
 * (asc) for a stable order.
 */
export function summarizeTools(jobs: RelayJob[]): ToolsSummary {
  const buckets = new Map<string, ToolBreakdown>();

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
