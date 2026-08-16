import { type ParseOptions, parseRateLimitMessage, type RateLimitPattern } from "./parser.js";
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

/**
 * Claude Code's non-interactive / print mode (`claude -p ...`) does not print a
 * prose sentence when it hits the usage limit — it emits a machine-readable line
 * of the form `Claude AI usage limit reached|<unix_epoch>`, where the number
 * after the pipe is the absolute reset time as a Unix epoch. This is the exact
 * format automated wrappers (e.g. claude-auto-retry) key on, and the one
 * AgentRelay is most likely to see in practice, since it wraps agents in headless
 * mode. The generic parser has no pipe-delimited epoch pattern (its `unix-epoch`
 * matcher requires a `retry_after` prefix), so this wording would otherwise slip
 * through. Kept as a Claude-specific adapter pattern rather than a generic one so
 * a bare `...|<digits>` elsewhere can't be misread as a reset.
 *
 * The epoch may arrive in *seconds* (10 digits, e.g. `1752345600`) or, from
 * runtimes that stamp `Date.now()` straight into the field, in *milliseconds*
 * (13 digits, e.g. `1752345600000`). We accept both and disambiguate purely by
 * digit count: seconds are multiplied to ms, milliseconds are used as-is. The
 * `\b` boundary plus fixed 13/10 lengths means 11–12 or 14+ digit garbage after
 * the pipe matches neither branch and is left alone (no misparse).
 */
const CLAUDE_USAGE_LIMIT_EPOCH_PATTERN: RateLimitPattern = {
  name: "claude-usage-limit-epoch",
  regex: /usage limit reached\s*\|\s*(\d{13}|\d{10})\b/i,
  resolve: (m) => {
    const digits = m[1];
    // 13 digits => epoch milliseconds (use as-is); 10 digits => epoch seconds.
    const ms = digits.length === 13 ? parseInt(digits, 10) : parseInt(digits, 10) * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  },
};

export const CLAUDE_CODE_ADAPTER: AgentAdapter = makeAdapter({
  tool: "claude-code",
  displayName: "Claude Code",
  binaries: ["claude", "claude-code"],
  patterns: [CLAUDE_USAGE_LIMIT_EPOCH_PATTERN],
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
