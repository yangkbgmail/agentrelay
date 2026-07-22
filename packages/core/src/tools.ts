// Discoverability layer for `agentrelay tools` — a diagnostic that lists the
// agent adapters AgentRelay ships with (the valid `--tool` values for
// run/parse/status/stats/export), the binaries each recognizes, the
// tool-specific rate-limit patterns each contributes, and — cross-referenced
// against the store — how many jobs currently run under each tool.
//
// Kept as pure functions (no I/O, no clock): callers pass the jobs, so the
// exact output is deterministic and testable. The CLI does the store read and
// rendering; core only shapes the data.

import { ADAPTERS } from "./adapters.js";
import { ALL_TOOLS } from "./stats.js";
import type { AgentTool, RelayJob } from "./types.js";

/**
 * A registered adapter's public-facing details, flattened from the internal
 * `AgentAdapter` (which also holds a `detectRateLimit` closure and raw pattern
 * regexes). Only the parts a user needs to discover and pick a tool.
 */
export interface AdapterInfo {
  /** The `--tool` id stored on each job, e.g. "codex-cli". */
  tool: AgentTool;
  /** Human-readable label, e.g. "Codex CLI". */
  displayName: string;
  /** argv[0] basenames that infer this tool from a command, e.g. ["codex"]. */
  binaries: string[];
  /**
   * Names of the tool-specific rate-limit patterns this adapter tries before
   * the generic ones. Empty means it relies purely on the generic parser.
   */
  patternNames: string[];
}

/**
 * Describe every registered adapter in a stable order (`ALL_TOOLS`), so the
 * output doesn't reshuffle between runs. Pure — reads only the static registry.
 */
export function describeAdapters(): AdapterInfo[] {
  return ALL_TOOLS.map((tool) => {
    const adapter = ADAPTERS[tool];
    return {
      tool: adapter.tool,
      displayName: adapter.displayName,
      binaries: [...adapter.binaries],
      patternNames: adapter.patterns.map((p) => p.name),
    };
  });
}

/**
 * Tally jobs by their `tool` field. Keys are the raw stored strings so a job
 * written by a newer/foreign store (an unrecognized tool) is still counted
 * rather than silently dropped. Pure.
 */
export function countJobsByTool(jobs: RelayJob[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const job of jobs) {
    const key = job.tool as string;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** One row of the tools report: an adapter (or an unregistered tool) + its job count. */
export interface ToolUsage {
  /** The tool id (registered adapter id, or a raw stored string if unregistered). */
  tool: string;
  /** Registered adapter details, or `null` for a tool present only in the store. */
  adapter: AdapterInfo | null;
  /** Number of jobs in the store currently using this tool. */
  jobCount: number;
}

/** The full `agentrelay tools` view: registered adapters + any store-only tools. */
export interface ToolReport {
  tools: ToolUsage[];
  /** Total jobs scanned (sum of all `jobCount`s). */
  totalJobs: number;
}

/**
 * Cross-reference the registered adapters with the store's jobs. Every
 * registered adapter appears (jobCount 0 when unused), followed by any
 * unregistered tool strings found in the store (sorted for determinism) so
 * nothing is hidden. Pure.
 */
export function summarizeTools(jobs: RelayJob[]): ToolReport {
  const counts = countJobsByTool(jobs);
  const adapters = describeAdapters();
  const seen = new Set<string>();

  const tools: ToolUsage[] = adapters.map((adapter) => {
    seen.add(adapter.tool);
    return { tool: adapter.tool, adapter, jobCount: counts[adapter.tool] ?? 0 };
  });

  const unknown = Object.keys(counts)
    .filter((t) => !seen.has(t))
    .sort();
  for (const t of unknown) {
    tools.push({ tool: t, adapter: null, jobCount: counts[t] });
  }

  return { tools, totalJobs: jobs.length };
}
