import { ADAPTERS } from "./adapters.js";
import { GENERIC_PATTERN_NAMES } from "./parser.js";
import { ACTIVE_STATUSES, ALL_TOOLS } from "./stats.js";
import type { AgentTool, RelayJob } from "./types.js";

/**
 * What AgentRelay knows about a single registered agent adapter, cross-referenced
 * with how the store actually uses it. Answers the question the other diagnostic
 * commands don't: `parse` tests one message, `patterns` shows which formats have
 * *fired*, but neither says *what tool adapters exist, how they're recognized
 * from a command, and which extra rate-limit formats each can match on top of
 * the generic parser*. `agentrelay tools` renders exactly that.
 */
export interface ToolAdapterInfo {
  /** Stable tool id stored on each job (see {@link AgentTool}). */
  tool: AgentTool;
  /** Human-readable label (e.g. "Claude Code"). */
  displayName: string;
  /** argv[0] basenames that infer this adapter from a bare command. */
  binaries: string[];
  /**
   * Tool-specific parser pattern names layered *before* the generic ones. Empty
   * when the adapter relies purely on the generic parser (the common case).
   */
  extraPatterns: string[];
  /** Jobs in the (scoped) store recorded against this tool. */
  jobCount: number;
  /** Of those, jobs in an active status (queued / waiting_for_reset / resuming). */
  activeCount: number;
}

/**
 * Fleet-wide adapter report for `agentrelay tools`. Lists every registered
 * adapter (in {@link ALL_TOOLS} order, so output is stable) plus the generic
 * pattern names all adapters fall back to.
 */
export interface ToolsReport {
  /** Generic rate-limit pattern names every adapter understands out of the box. */
  genericPatterns: string[];
  /** One entry per registered adapter, in ALL_TOOLS order. */
  adapters: ToolAdapterInfo[];
  /** Total jobs considered (after any scope filter the caller applied). */
  totalJobs: number;
}

const ACTIVE = new Set<string>(ACTIVE_STATUSES);

/**
 * Builds the {@link ToolsReport} for a job list. Pure and non-mutating: no I/O,
 * no ambient clock. The adapter set and their patterns come from the static
 * `ADAPTERS` registry; only the per-tool `jobCount`/`activeCount` depend on the
 * passed jobs. A job whose `tool` isn't a known adapter id (a corrupt/foreign
 * record) is counted in `totalJobs` but not attributed to any adapter bucket.
 */
export function describeTools(jobs: RelayJob[]): ToolsReport {
  const counts = new Map<AgentTool, { total: number; active: number }>();
  for (const tool of ALL_TOOLS) counts.set(tool, { total: 0, active: 0 });

  for (const job of jobs) {
    const bucket = counts.get(job.tool);
    if (!bucket) continue; // unknown/foreign tool id — defensive, not attributed
    bucket.total += 1;
    if (ACTIVE.has(job.status)) bucket.active += 1;
  }

  const adapters: ToolAdapterInfo[] = ALL_TOOLS.map((tool) => {
    const adapter = ADAPTERS[tool];
    const bucket = counts.get(tool) ?? { total: 0, active: 0 };
    return {
      tool,
      displayName: adapter.displayName,
      binaries: [...adapter.binaries],
      extraPatterns: adapter.patterns.map((p) => p.name),
      jobCount: bucket.total,
      activeCount: bucket.active,
    };
  });

  return {
    genericPatterns: [...GENERIC_PATTERN_NAMES],
    adapters,
    totalJobs: jobs.length,
  };
}
