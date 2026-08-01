import { ACTIVE_STATUSES } from "./stats.js";
import type { AgentTool, JobStatus, RelayJob } from "./types.js";

/**
 * Per-tool rollup for `agentrelay tools`. The `--tool` filter is threaded
 * through status/stats/export/cancel/retry/metrics/patterns/errors, but nothing
 * let you *discover* which agent tools actually appear in the store or compare
 * how reliably each one resolves. This fills that gap — the tool analogue of
 * `agentrelay projects`.
 *
 * Unlike `projects` (arbitrary user labels), the tool axis is a small fixed set
 * (`claude-code`/`codex-cli`/`generic`), so it's cheap to also carry a
 * per-tool reliability read — completed vs failed and the derived success rate —
 * which is the whole point of splitting by tool: seeing which adapter's resumes
 * land and which don't.
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
  /** Jobs that finished successfully. */
  completed: number;
  /** Jobs that exhausted retries and gave up. */
  failed: number;
  /** Jobs a user cancelled (excluded from success rate — not a tool failure). */
  cancelled: number;
  /**
   * completed / (completed + failed), or null when neither has occurred yet.
   * Cancelled jobs are deliberately excluded (a user choice, not a tool
   * outcome) — the same policy `computeStats` uses for its fleet-wide rate.
   */
  successRate: number | null;
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
 * Fleet-wide tool index: total jobs considered, the number of distinct tools
 * present, and the per-tool breakdown ranked so the tool with the most pending
 * work floats to the top.
 */
export interface ToolsSummary {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Number of distinct tools that appear in the considered jobs. */
  toolCount: number;
  /** Per-tool rows, ranked by active desc, then total desc, then name asc. */
  tools: ToolBreakdown[];
}

const ACTIVE_SET = new Set<JobStatus>(ACTIVE_STATUSES);

/**
 * Groups a job list by `job.tool` into a per-tool breakdown for
 * `agentrelay tools`. Pure and non-mutating: no I/O, no ambient clock. ISO
 * timestamps are compared lexically (they sort chronologically), matching how
 * `summarizeProjects`/`summarizeJobs` pick the earliest `resetAt`; a
 * missing/empty `resetAt` or `updatedAt` simply doesn't participate in the
 * min/max.
 *
 * Only tools that actually appear get a row (no zero-fill of the fixed tool
 * set) so the table reflects what's really in the store — the same "discover
 * what exists" intent as `summarizeProjects`. Rows are ranked by `active`
 * (desc) so a maintainer sees where work is pending first, then by `total`
 * (desc), then by tool name (asc) for a stable order.
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
        completed: 0,
        failed: 0,
        cancelled: 0,
        successRate: null,
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
    if (job.status === "completed") row.completed += 1;
    else if (job.status === "failed") row.failed += 1;
    else if (job.status === "cancelled") row.cancelled += 1;

    if (job.updatedAt && (row.lastActivityAt === null || job.updatedAt > row.lastActivityAt)) {
      row.lastActivityAt = job.updatedAt;
    }
  }

  for (const row of buckets.values()) {
    const resolved = row.completed + row.failed;
    row.successRate = resolved === 0 ? null : row.completed / resolved;
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
