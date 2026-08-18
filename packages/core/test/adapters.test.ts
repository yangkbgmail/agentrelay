import { describe, expect, it } from "vitest";
import {
  ADAPTERS,
  CLAUDE_CODE_ADAPTER,
  CODEX_CLI_ADAPTER,
  GEMINI_CLI_ADAPTER,
  GENERIC_ADAPTER,
  inferToolFromCommand,
  resolveAdapter,
} from "../src/adapters.js";

describe("inferToolFromCommand", () => {
  it("recognizes the claude binary", () => {
    expect(inferToolFromCommand(["claude", "-p", "continue"])).toBe("claude-code");
  });

  it("recognizes the codex binary", () => {
    expect(inferToolFromCommand(["codex", "exec", "fix the bug"])).toBe("codex-cli");
  });

  it("recognizes the gemini binary", () => {
    expect(inferToolFromCommand(["gemini", "-p", "continue"])).toBe("gemini-cli");
    expect(inferToolFromCommand(["gemini-cli", "chat"])).toBe("gemini-cli");
  });

  it("strips a directory prefix and .exe suffix before matching", () => {
    expect(inferToolFromCommand(["/usr/local/bin/codex"])).toBe("codex-cli");
    expect(inferToolFromCommand(["C:\\tools\\claude.exe"])).toBe("claude-code");
  });

  it("returns undefined for an unknown binary", () => {
    expect(inferToolFromCommand(["some-other-agent"])).toBeUndefined();
    expect(inferToolFromCommand([])).toBeUndefined();
  });
});

describe("resolveAdapter", () => {
  it("prefers an explicit tool over the command", () => {
    const adapter = resolveAdapter({ tool: "codex-cli", command: ["claude"] });
    expect(adapter).toBe(CODEX_CLI_ADAPTER);
  });

  it("infers from the command when no tool is given", () => {
    expect(resolveAdapter({ command: ["codex"] })).toBe(CODEX_CLI_ADAPTER);
    expect(resolveAdapter({ command: ["claude"] })).toBe(CLAUDE_CODE_ADAPTER);
  });

  it("falls back to the generic adapter when nothing matches", () => {
    expect(resolveAdapter({ command: ["mystery-cli"] })).toBe(GENERIC_ADAPTER);
    expect(resolveAdapter({})).toBe(GENERIC_ADAPTER);
  });

  it("infers the Gemini adapter from a gemini command", () => {
    expect(resolveAdapter({ command: ["gemini"] })).toBe(GEMINI_CLI_ADAPTER);
    expect(resolveAdapter({ tool: "gemini-cli" })).toBe(GEMINI_CLI_ADAPTER);
  });

  it("exposes every AgentTool in the registry", () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual(["claude-code", "codex-cli", "gemini-cli", "generic"]);
  });
});

describe("adapter rate-limit detection", () => {
  const now = new Date("2026-07-12T10:00:00Z");

  it("Codex adapter parses seconds-based waits the generic parser misses", () => {
    const result = CODEX_CLI_ADAPTER.detectRateLimit("Rate limit reached for gpt-4. Please try again in 20s.", { now });
    expect(result?.pattern).toBe("codex-relative-seconds");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 20_000).toISOString());
  });

  it("Codex adapter handles fractional seconds and rounds up to whole ms", () => {
    // 1.5s -> exactly 1500ms (already whole ms, so no early resume).
    expect(CODEX_CLI_ADAPTER.detectRateLimit("try again in 1.5s", { now })?.resetAt).toBe(
      new Date(now.getTime() + 1500).toISOString()
    );
    // 0.4001s -> 400.1ms rounded up to 401ms so we never resume before the wait.
    expect(CODEX_CLI_ADAPTER.detectRateLimit("retry after 0.4001s", { now })?.resetAt).toBe(
      new Date(now.getTime() + 401).toISOString()
    );
  });

  it("Codex adapter still falls back to the generic patterns", () => {
    const result = CODEX_CLI_ADAPTER.detectRateLimit("Usage limit reached. Resets in 30m.", { now });
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 30 * 60_000).toISOString());
  });

  it("the generic adapter does NOT understand seconds-only waits", () => {
    // This is the whole point of the Codex adapter: the generic parser has no
    // seconds pattern, so a bare "in 20s" wait is not recognized without it.
    expect(GENERIC_ADAPTER.detectRateLimit("try again in 20s", { now })).toBeNull();
  });

  it("the Claude Code adapter behaves like the generic parser", () => {
    const text = "usage limit reached, resets at 2026-07-13T05:00:00Z";
    expect(CLAUDE_CODE_ADAPTER.detectRateLimit(text, { now })?.pattern).toBe("iso-timestamp");
  });

  it("Claude Code adapter parses the machine-readable 'reached|<epoch>' print-mode format", () => {
    // What `claude -p` actually emits when rate-limited: an absolute reset time
    // as Unix epoch seconds after a pipe. epoch 1752345600 -> 2025-07-12T18:40:00Z.
    const result = CLAUDE_CODE_ADAPTER.detectRateLimit("Claude AI usage limit reached|1752345600", { now });
    expect(result?.pattern).toBe("claude-usage-limit-epoch");
    expect(result?.resetAt).toBe(new Date(1752345600 * 1000).toISOString());
    expect(result?.rawMatch).toBe("usage limit reached|1752345600");
  });

  it("Claude Code adapter tolerates whitespace around the pipe and mixed case", () => {
    expect(CLAUDE_CODE_ADAPTER.detectRateLimit("Usage Limit Reached | 1752345600", { now })?.pattern).toBe(
      "claude-usage-limit-epoch"
    );
  });

  it("the generic adapter does NOT understand the pipe-delimited epoch format", () => {
    // This is the whole point of putting it on the Claude adapter: a bare
    // "...|<10 digits>" must not be treated as a reset by the generic parser.
    expect(GENERIC_ADAPTER.detectRateLimit("Claude AI usage limit reached|1752345600", { now })).toBeNull();
  });

  it("Claude Code adapter still falls back to the generic patterns", () => {
    const result = CLAUDE_CODE_ADAPTER.detectRateLimit("Usage limit reached. Resets in 30m.", { now });
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 30 * 60_000).toISOString());
  });

  it("Gemini adapter parses the RESOURCE_EXHAUSTED retryDelay the generic parser misses", () => {
    // What the Gemini API actually returns on a 429: a google.rpc.RetryInfo
    // detail with the wait as a seconds string. epoch-free, relative to now.
    const text =
      '[API Error: 429 Too Many Requests {"error":{"status":"RESOURCE_EXHAUSTED",' +
      '"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"56s"}]}}]';
    const result = GEMINI_CLI_ADAPTER.detectRateLimit(text, { now });
    expect(result?.pattern).toBe("gemini-retry-delay");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 56_000).toISOString());
  });

  it("Gemini adapter tolerates snake/kebab/spaced spellings and unquoted values", () => {
    for (const text of ["retry_delay: 30s", "retry-delay = 30s", 'retryDelay":"30s"', "retry delay: 30s"]) {
      expect(GEMINI_CLI_ADAPTER.detectRateLimit(text, { now })?.resetAt).toBe(
        new Date(now.getTime() + 30_000).toISOString()
      );
    }
  });

  it("Gemini adapter rounds a fractional retryDelay up to whole ms", () => {
    // 2.4001s -> 2400.1ms rounded up to 2401ms so we never resume before the wait.
    expect(GEMINI_CLI_ADAPTER.detectRateLimit('"retryDelay": "2.4001s"', { now })?.resetAt).toBe(
      new Date(now.getTime() + 2401).toISOString()
    );
  });

  it("Gemini adapter still falls back to the generic patterns", () => {
    const result = GEMINI_CLI_ADAPTER.detectRateLimit("Quota exceeded. Resets in 2h.", { now });
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 2 * 60 * 60_000).toISOString());
  });

  it("the generic adapter does NOT understand the retryDelay seconds format", () => {
    // The whole point of the Gemini adapter: the generic parser has neither a
    // seconds unit nor a retryDelay key, so this wait slips through without it.
    expect(GENERIC_ADAPTER.detectRateLimit('"retryDelay": "56s"', { now })).toBeNull();
  });
});
