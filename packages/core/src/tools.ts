import { ACTIVE_STATUSES } from "./stats.js";
import type { AgentTool, JobStatus, RelayJob } from "./types.js";

/**
 * Per-tool rollup for `agentrelay tools`. The whole `--tool` filter ecosystem
 * (status/stats/export/cancel/retry/metrics/patterns/errors/projects/upcoming)
 * keys off `job.tool`, but until now nothing let you *discover* which agent
 * tools actually appear in the store, or see where work is pending per tool.
 * This fills that gap — the tool-axis sibling of `agentrelay projects`.
 *
 * Because the tool set is a small fixed enum (claude-code/codex-cli/generic),
 * each row also lists the distinct binaries (`command[0]`) actually spawned
 * under that tool. That's the detail `stats --group-by tool` can't show and the
 * one a maintainer wants when a resume silently fails: the `generic` adapter in
 * particular can front any binary, and this is where you see which ones — the
 * same binaries `doctor`'s PATH check probes.
 */
export interface ToolBreakdown {
  /** The agent tool label (`job.tool`). */
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
   * Distinct binaries (`command[0]`) spawned under this tool, in first-seen
   * order. Empty commands are ignored. For `generic` this reveals exactly which
   * executables front the relay; for the others it's usually a single entry.
   */
  binaries: string[];
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
 * `summarizeJobs`/`summarizeProjects` pick the earliest `resetAt`; a
 * missing/empty `resetAt` or `updatedAt` simply doesn't participate in the
 * min/max. Only tools actually present get a row (no zero-fill) so the output
 * reflects the real store, unlike the fixed-shape `stats.byTool`.
 *
 * Rows are ranked by `active` (desc) so a maintainer sees where work is pending
 * first, then by `total` (desc), then by tool name (asc) for a stable order.
 */
export function summarizeTools(jobs: RelayJob[]): ToolsSummary {
  const buckets = new Map<AgentTool, ToolBreakdown>();
  // Track seen binaries per tool for O(1) de-dup while preserving first-seen order.
  const seenBinaries = new Map<AgentTool, Set<string>>();

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
        binaries: [],
        nextResetAt: null,
        lastActivityAt: null,
      };
      buckets.set(tool, row);
      seenBinaries.set(tool, new Set());
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

    const binary = job.command[0];
    if (binary) {
      const seen = seenBinaries.get(tool);
      if (seen && !seen.has(binary)) {
        seen.add(binary);
        row.binaries.push(binary);
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
