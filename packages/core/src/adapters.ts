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
  /**
   * Rewrite the original command for a *resume* run so the agent continues its
   * previous session instead of starting the task over from scratch. Returns
   * the command unchanged when the tool has no context-preserving flag, when
   * the tool's binary isn't recognized in the command, or when a continue/
   * resume flag is already present (idempotent). Only the scheduler calls this
   * — the very first run always executes the literal command the user gave.
   */
  buildResumeCommand(command: string[]): string[];
}

/** Optional per-tool resume-command transform; defaults to re-running verbatim. */
type AdapterSpec = Omit<AgentAdapter, "detectRateLimit" | "buildResumeCommand"> & {
  resume?: (command: string[]) => string[];
};

function makeAdapter(spec: AdapterSpec): AgentAdapter {
  const resume = spec.resume ?? ((command: string[]) => command);
  return {
    tool: spec.tool,
    displayName: spec.displayName,
    binaries: spec.binaries,
    patterns: spec.patterns,
    detectRateLimit(output, options = {}) {
      return parseRateLimitMessage(output, {
        ...options,
        extraPatterns: [...spec.patterns, ...(options.extraPatterns ?? [])],
      });
    },
    buildResumeCommand(command) {
      return resume(command);
    },
  };
}

/** argv[0] basenames that identify the Claude Code CLI. */
const CLAUDE_BINARIES = ["claude", "claude-code"];

/** The flag that makes Claude Code continue the most recent session in the cwd. */
export const CLAUDE_CONTINUE_FLAG = "--continue";

/**
 * Flags that already continue/resume a prior Claude Code session. If the user's
 * command carries any of these we leave it alone so we never double-continue.
 */
const CLAUDE_RESUME_FLAGS = new Set(["--continue", "-c", "--resume", "-r"]);

/**
 * Rewrite a Claude Code command so a *resume* run continues the previous
 * conversation (SPEC §4: "가능하면 --resume/컨텍스트 유지 플래그 사용") instead of
 * re-issuing the prompt as a brand-new session.
 *
 * Conservative and idempotent: only rewrites when the `claude` binary is
 * actually present in the command (so wrappers we don't understand are left
 * untouched), inserts `--continue` right after that binary token (so
 * `npx claude …` becomes `npx claude --continue …`), and no-ops when a
 * continue/resume flag is already there.
 */
export function insertClaudeContinueFlag(command: string[]): string[] {
  if (command.length === 0) return command;
  const binaryIndex = command.findIndex((token) => CLAUDE_BINARIES.includes(baseName(token)));
  if (binaryIndex === -1) return command;
  if (command.some((token) => CLAUDE_RESUME_FLAGS.has(token))) return command;
  const next = command.slice();
  next.splice(binaryIndex + 1, 0, CLAUDE_CONTINUE_FLAG);
  return next;
}

/**
 * Whether the scheduler should rewrite a resumed command to continue the prior
 * session (see {@link AgentAdapter.buildResumeCommand}). On by default so the
 * flagship Claude Code flow keeps its context across rate-limit windows; set
 * `AGENTRELAY_RESUME_CONTINUE` to a falsy value (`0`/`false`/`off`/`no`) to make
 * resumes re-run the literal command the user originally gave instead.
 */
export function resumeWithContextFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.AGENTRELAY_RESUME_CONTINUE;
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  if (value === "") return true;
  return !(value === "0" || value === "false" || value === "off" || value === "no");
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
  binaries: CLAUDE_BINARIES,
  patterns: [],
  resume: insertClaudeContinueFlag,
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
