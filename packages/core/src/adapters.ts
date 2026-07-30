import { GENERIC_PATTERN_NAMES, type ParseOptions, parseRateLimitMessage, type RateLimitPattern } from "./parser.js";
import type { AgentTool, RateLimitInfo } from "./types.js";

/**
 * An agent adapter encapsulates the tool-specific knowledge AgentRelay needs to
 * wrap a given AI coding CLI: which binary invokes it, and how *that tool*
 * phrases its rate-limit / usage-limit messages.
 *
 * The generic parser (`parseRateLimitMessage`) already covers the common
 * formats, so most adapters just delegate to it. An adapter contributes extra
 * `patterns` only when its tool uses wording the generic parser misses — those
 * patterns are tried first, then the generic ones as a fallback.
 *
 * Add a new tool by writing an adapter here and registering it in `ADAPTERS`.
 */
export interface AgentAdapter {
  /** Stable identifier stored on each job. */
  tool: AgentTool;
  /** Human-readable label for logs / dashboard. */
  displayName: string;
  /**
   * argv[0] basenames that identify this tool, e.g. `["claude"]`. Used to infer
   * the adapter from a command when the caller didn't pass an explicit tool.
   */
  binaries: string[];
  /** Tool-specific rate-limit patterns, tried before the generic ones. */
  patterns: RateLimitPattern[];
  /**
   * Detect a rate-limit message in command output. Delegates to the generic
   * parser but injects this adapter's patterns at highest priority.
   */
  detectRateLimit(output: string, options?: ParseOptions): RateLimitInfo | null;
}

function makeAdapter(spec: Omit<AgentAdapter, "detectRateLimit">): AgentAdapter {
  return {
    ...spec,
    detectRateLimit(output, options = {}) {
      return parseRateLimitMessage(output, {
        ...options,
        extraPatterns: [...spec.patterns, ...(options.extraPatterns ?? [])],
      });
    },
  };
}

/**
 * OpenAI-style APIs (which Codex CLI talks to) frequently return sub-minute
 * waits phrased in *seconds*, e.g. "Rate limit reached ... Please try again in
 * 20s" or "try again in 1.5s". The generic `relative-duration` pattern only
 * understands hours/minutes, so seconds would otherwise be missed. Match a
 * bare/fractional seconds delay and round up so we never resume too early.
 */
const CODEX_SECONDS_PATTERN: RateLimitPattern = {
  name: "codex-relative-seconds",
  regex: /(?:try again|retry|resets?)(?:\s+again)?\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\b/i,
  resolve: (m, now) => {
    const seconds = parseFloat(m[1]);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return new Date(now.getTime() + Math.ceil(seconds * 1000));
  },
};

export const CLAUDE_CODE_ADAPTER: AgentAdapter = makeAdapter({
  tool: "claude-code",
  displayName: "Claude Code",
  binaries: ["claude", "claude-code"],
  patterns: [],
});

export const CODEX_CLI_ADAPTER: AgentAdapter = makeAdapter({
  tool: "codex-cli",
  displayName: "Codex CLI",
  binaries: ["codex", "codex-cli"],
  patterns: [CODEX_SECONDS_PATTERN],
});

export const GENERIC_ADAPTER: AgentAdapter = makeAdapter({
  tool: "generic",
  displayName: "Generic agent",
  binaries: [],
  patterns: [],
});

/** All registered adapters, keyed by their `tool` id. */
export const ADAPTERS: Record<AgentTool, AgentAdapter> = {
  "claude-code": CLAUDE_CODE_ADAPTER,
  "codex-cli": CODEX_CLI_ADAPTER,
  generic: GENERIC_ADAPTER,
};

/**
 * A read-only, JSON-friendly description of a single registered adapter — the
 * static facts a user needs to discover which `--tool` values are valid, which
 * binaries auto-infer to which tool, and what extra rate-limit patterns (beyond
 * the shared generic vocabulary) that tool contributes. Pure data: no functions,
 * no `RegExp` objects, so it round-trips through JSON losslessly.
 */
export interface AdapterDescription {
  /** Stable tool id — a valid value for `--tool` everywhere it is accepted. */
  tool: AgentTool;
  /** Human-readable label. */
  displayName: string;
  /** argv[0] basenames that auto-infer this tool from a `run` command. */
  binaries: string[];
  /** Names of this adapter's own patterns, tried before the generic ones. */
  extraPatterns: string[];
  /** True for the fallback adapter used when nothing else matches (`generic`). */
  isDefault: boolean;
}

/** The tool id `resolveAdapter` falls back to when no tool is given or inferred. */
export const DEFAULT_ADAPTER_TOOL: AgentTool = GENERIC_ADAPTER.tool;

/**
 * Describe every registered adapter as plain data for discovery surfaces (e.g.
 * `agentrelay adapters`). Pure: reads only the static `ADAPTERS` registry and
 * the generic parser vocabulary — no I/O, no clock. Registry insertion order is
 * preserved so the listing is stable across runs. `extraPatterns` lists only the
 * adapter-specific patterns; the shared generic patterns are exposed separately
 * as {@link GENERIC_PATTERN_NAMES} so they are not duplicated per adapter.
 */
export function describeAdapters(): AdapterDescription[] {
  return Object.values(ADAPTERS).map((adapter) => ({
    tool: adapter.tool,
    displayName: adapter.displayName,
    binaries: [...adapter.binaries],
    extraPatterns: adapter.patterns.map((p) => p.name),
    isDefault: adapter.tool === DEFAULT_ADAPTER_TOOL,
  }));
}

/** Strip any directory / .exe suffix from an argv[0] to get the bare binary name. */
function baseName(bin: string): string {
  const last = bin.split(/[\\/]/).pop() ?? bin;
  return last.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

/**
 * Infer which tool a command belongs to from its argv[0]. Returns `undefined`
 * when nothing matches so callers can decide their own default.
 */
export function inferToolFromCommand(command: string[]): AgentTool | undefined {
  const bin = command.length > 0 ? baseName(command[0]) : "";
  if (!bin) return undefined;
  for (const adapter of Object.values(ADAPTERS)) {
    if (adapter.binaries.includes(bin)) return adapter.tool;
  }
  return undefined;
}

export interface ResolveAdapterOptions {
  /** Explicit tool id, if the caller knows it. Takes priority over inference. */
  tool?: AgentTool;
  /** Command to infer the tool from when `tool` is omitted. */
  command?: string[];
}

/**
 * Resolve the adapter to use for a job. Priority: explicit `tool` → inferred
 * from `command` → the generic adapter. Always returns an adapter.
 */
export function resolveAdapter(options: ResolveAdapterOptions = {}): AgentAdapter {
  if (options.tool && ADAPTERS[options.tool]) return ADAPTERS[options.tool];
  if (options.command) {
    const inferred = inferToolFromCommand(options.command);
    if (inferred) return ADAPTERS[inferred];
  }
  return GENERIC_ADAPTER;
}
