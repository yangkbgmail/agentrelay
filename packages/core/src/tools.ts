import { ADAPTERS } from "./adapters.js";
import { ACTIVE_STATUSES } from "./stats.js";
import type { AgentTool, JobStatus, RelayJob } from "./types.js";

/**
 * Introspective view of a single registered agent adapter, cross-referenced with
 * how much the queue actually uses it. This is the *adapter*-facing analog of
 * `agentrelay patterns` (which counts parser-pattern firings): where `patterns`
 * answers "which rate-limit message formats fire in the wild", this answers
 * "what agent tools does AgentRelay support at all, what binaries/patterns does
 * each recognize, and how many jobs do I actually run under each".
 *
 * `binaries`/`patternNames` come straight from the adapter registry
 * (`ADAPTERS`), so a maintainer can eyeball an adapter's capabilities without
 * reading `adapters.ts`; `jobs`/`activeJobs` come from the job list passed in.
 */
export interface AdapterToolStat {
  /** Stable tool id stored on each job. */
  tool: AgentTool;
  /** Human-readable label from the adapter. */
  displayName: string;
  /** argv[0] basenames that infer this tool (e.g. `["claude", "claude-code"]`). */
  binaries: string[];
  /** Number of tool-specific rate-limit patterns this adapter injects. */
  patternCount: number;
  /** Names of those tool-specific patterns (empty when the adapter relies on the generic parser). */
  patternNames: string[];
  /** Jobs in the (scoped) queue whose `tool` is this adapter. */
  jobs: number;
  /** Of those, jobs the relay is still working (queued + waiting_for_reset + resuming). */
  activeJobs: number;
}

/** A tool id that appears on a job but isn't in the adapter registry (defensive / forward-compat). */
export interface UnknownToolStat {
  tool: string;
  jobs: number;
}

/**
 * Fleet-wide summary of the adapter registry and its usage. `adapters` always
 * lists every registered adapter in registry order (even ones with zero jobs,
 * so the supported-tool surface is always visible); `unknownTools` collects any
 * job whose `tool` isn't a registered adapter — normally empty, but a job loaded
 * from a newer store or a hand-edited file could carry one, and silently
 * dropping it would misreport usage.
 */
export interface AdapterSummary {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** One entry per registered adapter, in `ADAPTERS` order. */
  adapters: AdapterToolStat[];
  /** Jobs whose tool id isn't in the registry, ranked by count (desc), then name (asc). */
  unknownTools: UnknownToolStat[];
}

const ACTIVE = new Set<JobStatus>(ACTIVE_STATUSES);

/**
 * Summarize the adapter registry cross-referenced with a job list. Pure and
 * non-mutating: no I/O, no ambient clock. Registered adapters are always
 * reported (registry order, zero-filled), so the command doubles as
 * "which tools does this build support"; any job carrying an unregistered tool
 * id lands in `unknownTools` rather than being dropped.
 */
export function summarizeAdapters(jobs: RelayJob[]): AdapterSummary {
  const registered = new Map<AgentTool, { jobs: number; activeJobs: number }>();
  for (const tool of Object.keys(ADAPTERS) as AgentTool[]) {
    registered.set(tool, { jobs: 0, activeJobs: 0 });
  }
  const unknown = new Map<string, number>();

  for (const job of jobs) {
    const tool = job.tool as string;
    const bucket = registered.get(tool as AgentTool);
    if (bucket) {
      bucket.jobs += 1;
      if (ACTIVE.has(job.status)) bucket.activeJobs += 1;
    } else {
      unknown.set(tool, (unknown.get(tool) ?? 0) + 1);
    }
  }

  const adapters: AdapterToolStat[] = (Object.keys(ADAPTERS) as AgentTool[]).map((tool) => {
    const adapter = ADAPTERS[tool];
    const usage = registered.get(tool) ?? { jobs: 0, activeJobs: 0 };
    return {
      tool,
      displayName: adapter.displayName,
      binaries: [...adapter.binaries],
      patternCount: adapter.patterns.length,
      patternNames: adapter.patterns.map((p) => p.name),
      jobs: usage.jobs,
      activeJobs: usage.activeJobs,
    };
  });

  const unknownTools: UnknownToolStat[] = [...unknown.entries()]
    .map(([tool, count]) => ({ tool, jobs: count }))
    .sort((a, b) => (b.jobs !== a.jobs ? b.jobs - a.jobs : a.tool.localeCompare(b.tool)));

  return { total: jobs.length, adapters, unknownTools };
}
