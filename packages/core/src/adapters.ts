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
   * Transform a command into its context-preserving *resume* form — the way you
   * would re-invoke the tool to continue the previous conversation rather than
   * start over (e.g. Claude Code's `--continue`). The scheduler applies this only
   * when a job opted into context-preserving resume (`RelayJob.resumeContext`);
   * verbatim re-run stays the default. Returns the command unchanged when the
   * tool has no such flag or one is already present. Pure and side-effect free.
   */
  resumeCommand(command: string[]): string[];
  /**
   * Detect a rate-limit message in command output. Delegates to the generic
   * parser but injects this adapter's patterns at highest priority.
   */
  detectRateLimit(output: string, options?: ParseOptions): RateLimitInfo | null;
}

/** Identity transform: tools without a context-preserving resume flag re-run verbatim. */
const identityResume = (command: string[]): string[] => command;

function makeAdapter(
  spec: Omit<AgentAdapter, "detectRateLimit" | "resumeCommand"> & {
    resumeCommand?: (command: string[]) => string[];
  }
): AgentAdapter {
  const resumeCommand = spec.resumeCommand ?? identityResume;
  return {
    ...spec,
    resumeCommand,
    detectRateLimit(output, options = {}) {
      return parseRateLimitMessage(output, {
        ...options,
        extraPatterns: [...spec.patterns, ...(options.extraPatterns ?? [])],
      });
    },
  };
}

/**
 * Claude Code continues the most recent conversation in a working directory with
 * `--continue` (`-c`). When resuming a rate-limited `claude -p "..."` run we want
 * to pick that conversation back up instead of starting a fresh one, so insert
 * `--continue` right after the binary — unless the command already asks to
 * continue or resume a session, so we never double the flag or override an
 * explicit `--resume <id>`.
 */
export function claudeResumeCommand(command: string[]): string[] {
  if (command.length === 0) return command;
  const rest = command.slice(1);
  const alreadyResuming = rest.some(
    (arg) => arg === "--continue" || arg === "-c" || arg === "--resume" || arg === "-r" || arg.startsWith("--resume=")
  );
  if (alreadyResuming) return command;
  return [command[0], "--continue", ...rest];
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
 * Google's Gemini API (which the `gemini` CLI talks to) reports how long to back
 * off with a machine-readable `RetryInfo` field embedded in the 429 error
 * payload, e.g.
 *
 *   429 Too Many Requests {"error":{...,"status":"RESOURCE_EXHAUSTED",
 *     "details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo",
 *     "retryDelay":"56s"}]}}
 *
 * The delay is a protobuf `Duration` string, always expressed in *seconds* with
 * a trailing `s` (e.g. `"56s"`, `"27.5s"`). The generic parser only understands
 * hours/minutes prose, and the Codex seconds pattern requires "try again/retry"
 * wording that this structured field lacks, so a `retryDelay` would otherwise be
 * missed. Keyed on the literal field name so it stays disjoint from the other
 * patterns. Accepts `retryDelay` / `retry_delay` / `retry-delay` and tolerates
 * optional surrounding quotes on both the key and the value. Rounds the wait up
 * to whole milliseconds so we never resume before the API is willing to serve.
 */
const GEMINI_RETRY_DELAY_PATTERN: RateLimitPattern = {
  name: "gemini-retry-delay",
  regex: /retry[_-]?delay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)\s*s"?/i,
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
 * AgentRelay is most likely to see in practice, since it wraps agents in
 * headless mode. The generic parser has no pipe-delimited epoch pattern (its
 * `unix-epoch` matcher requires a `retry_after`/`reset_at` prefix), so this
 * wording would otherwise slip through. Kept as a Claude-specific adapter pattern
 * rather than a generic one so a bare `...|<digits>` elsewhere can't be misread
 * as a reset.
 *
 * The epoch is normally 10-digit *seconds*, but different Claude/wrapper versions
 * have been observed emitting a 13-digit *millisecond* epoch (e.g. when the value
 * comes straight from `Date.now()`), so both widths are accepted and told apart by
 * digit count. The `\b` boundary keeps ambiguous 11/12-digit values (neither a
 * clean seconds nor a clean ms epoch) from matching — falling through beats
 * resuming at a wildly wrong time.
 */
const CLAUDE_USAGE_LIMIT_EPOCH_PATTERN: RateLimitPattern = {
  name: "claude-usage-limit-epoch",
  // Try 13-digit ms first, then 10-digit seconds; `\b` rejects other widths.
  regex: /usage limit reached\s*\|\s*(\d{13}|\d{10})\b/i,
  resolve: (m) => {
    const digits = m[1];
    const value = parseInt(digits, 10);
    if (!Number.isFinite(value)) return null;
    const ms = digits.length === 13 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  },
};

export const CLAUDE_CODE_ADAPTER: AgentAdapter = makeAdapter({
  tool: "claude-code",
  displayName: "Claude Code",
  binaries: ["claude", "claude-code"],
  patterns: [CLAUDE_USAGE_LIMIT_EPOCH_PATTERN],
  resumeCommand: claudeResumeCommand,
});

export const CODEX_CLI_ADAPTER: AgentAdapter = makeAdapter({
  tool: "codex-cli",
  displayName: "Codex CLI",
  binaries: ["codex", "codex-cli"],
  patterns: [CODEX_SECONDS_PATTERN],
});

export const GEMINI_CLI_ADAPTER: AgentAdapter = makeAdapter({
  tool: "gemini-cli",
  displayName: "Gemini CLI",
  binaries: ["gemini"],
  patterns: [GEMINI_RETRY_DELAY_PATTERN],
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
  "gemini-cli": GEMINI_CLI_ADAPTER,
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
