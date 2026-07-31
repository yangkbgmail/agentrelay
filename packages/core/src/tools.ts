import { ADAPTERS } from "./adapters.js";
import { ACTIVE_STATUSES, ALL_TOOLS } from "./stats.js";
import type { AgentTool, JobStatus, RelayJob } from "./types.js";

/**
 * Per-tool rollup for `agentrelay tools`. This is the tool-axis twin of
 * `agentrelay projects`: the whole `--tool` filter ecosystem
 * (status/stats/export/cancel/retry/metrics/patterns/errors) keys off
 * `job.tool`, but nothing let you *discover* which agent tools are actually in
 * the queue, what binaries their adapter spawns, or where per-tool work is
 * pending. Unlike project labels (arbitrary strings), tools come from a fixed
 * adapter registry, so each row is enriched with that adapter's metadata — the
 * command doubles as a listing of the adapters AgentRelay knows how to drive.
 */
export interface ToolBreakdown {
  /** The tool id stored on each job (e.g. `claude-code`). */
  tool: string;
  /** Human-readable adapter label, or the raw tool id when unregistered. */
  displayName: string;
  /**
   * argv[0] basenames the adapter recognizes for this tool (what `doctor`'s
   * PATH check spawns). Empty for the generic/unregistered case.
   */
  binaries: string[];
  /**
   * True when this tool has a registered adapter. False for tool strings that
   * appear on jobs (e.g. from an `import`) but aren't in the registry.
   */
  registered: boolean;
  /** Total jobs carrying this tool (within any scope the caller applied). */
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
 * Fleet-wide tool index: total jobs considered, how many distinct tools carry
 * jobs, how many registered adapters exist, and the per-tool breakdown.
 */
export interface ToolsSummary {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Number of distinct tools that actually carry at least one job. */
  toolCount: number;
  /** Number of registered adapters (rows always include all of them). */
  registeredCount: number;
  /** Per-tool rows, ranked by active desc, total desc, registered-first, name asc. */
  tools: ToolBreakdown[];
}

const ACTIVE_SET = new Set<JobStatus>(ACTIVE_STATUSES);
const REGISTERED_TOOLS = new Set<string>(ALL_TOOLS);

function newRow(tool: string): ToolBreakdown {
  const adapter = ADAPTERS[tool as AgentTool];
  return {
    tool,
    displayName: adapter ? adapter.displayName : tool,
    binaries: adapter ? [...adapter.binaries] : [],
    registered: REGISTERED_TOOLS.has(tool),
    total: 0,
    active: 0,
    terminal: 0,
    waiting: 0,
    nextResetAt: null,
    lastActivityAt: null,
  };
}

/**
 * Groups a job list by `job.tool` into a per-tool breakdown for `agentrelay
 * tools`. Pure and non-mutating: no I/O, no ambient clock. ISO timestamps are
 * compared lexically (they sort chronologically), matching how `summarizeJobs`
 * and `summarizeProjects` already pick the earliest `resetAt`; a missing/empty
 * `resetAt` or `updatedAt` simply doesn't participate in the min/max.
 *
 * Every registered adapter appears as a row even with zero jobs, so the command
 * doubles as a registry listing (discover what AgentRelay can drive). Tool ids
 * on jobs that aren't registered (e.g. from an `import` of an older/foreign
 * store) also get a row, flagged `registered: false`.
 *
 * Rows are ranked by `active` (desc) so a maintainer sees where work is pending
 * first, then `total` (desc), then registered adapters before unregistered
 * ones, then tool id (asc) for a stable order.
 */
export function summarizeTools(jobs: RelayJob[]): ToolsSummary {
  const buckets = new Map<string, ToolBreakdown>();
  // Seed every registered adapter so it shows even with no jobs.
  for (const tool of ALL_TOOLS) buckets.set(tool, newRow(tool));

  const seenWithJobs = new Set<string>();
  for (const job of jobs) {
    const tool = job.tool;
    let row = buckets.get(tool);
    if (!row) {
      row = newRow(tool);
      buckets.set(tool, row);
    }
    seenWithJobs.add(tool);

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
    if (a.registered !== b.registered) return a.registered ? -1 : 1;
    return a.tool.localeCompare(b.tool);
  });

  return {
    total: jobs.length,
    toolCount: seenWithJobs.size,
    registeredCount: ALL_TOOLS.length,
    tools,
  };
}
