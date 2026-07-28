import { ADAPTERS, type AgentAdapter } from "./adapters.js";
import type { AgentTool } from "./types.js";

/**
 * A flattened, presentation-friendly view of one registered agent adapter — the
 * static knowledge AgentRelay has about a given AI coding CLI: which binaries
 * invoke it, and which tool-specific rate-limit patterns it contributes on top
 * of the generic parser.
 *
 * This is the read-only counterpart to `adapters.ts`: `adapters.ts` decides how
 * to *detect* rate limits, this module answers "which tools do we understand,
 * and how?" so a user can see what `--tool` accepts and which binaries
 * auto-infer their tool.
 */
export interface AdapterDescription {
  /** Stable adapter id (also the `--tool` value). */
  tool: AgentTool;
  /** Human-readable label. */
  displayName: string;
  /** argv[0] basenames that auto-infer this tool (empty for the generic catch-all). */
  binaries: string[];
  /** Names of tool-specific patterns tried before the generic ones (empty = generic only). */
  extraPatterns: string[];
  /** True for the catch-all generic adapter (no binaries, no extra patterns of its own). */
  isGeneric: boolean;
}

function isGenericAdapter(adapter: AgentAdapter): boolean {
  return adapter.tool === "generic";
}

/**
 * Describe every registered adapter for display. Pure — no filesystem, no clock.
 * Specific tools are listed in registry order first, with the generic catch-all
 * adapter always last (it's the fallback, not a tool you'd usually pick).
 */
export function describeAdapters(adapters: Record<AgentTool, AgentAdapter> = ADAPTERS): AdapterDescription[] {
  const descriptions = Object.values(adapters).map(
    (adapter): AdapterDescription => ({
      tool: adapter.tool,
      displayName: adapter.displayName,
      binaries: [...adapter.binaries],
      extraPatterns: adapter.patterns.map((p) => p.name),
      isGeneric: isGenericAdapter(adapter),
    })
  );
  // Stable order: generic sinks to the bottom, everything else keeps registry order.
  return descriptions
    .map((d, index) => ({ d, index }))
    .sort((a, b) => {
      if (a.d.isGeneric !== b.d.isGeneric) return a.d.isGeneric ? 1 : -1;
      return a.index - b.index;
    })
    .map(({ d }) => d);
}
