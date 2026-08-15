import { describe, expect, it } from "vitest";
import {
  ADAPTERS,
  AIDER_ADAPTER,
  CLAUDE_CODE_ADAPTER,
  CODEX_CLI_ADAPTER,
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

  it("recognizes the aider binary", () => {
    expect(inferToolFromCommand(["aider", "--yes", "src/app.py"])).toBe("aider");
    expect(inferToolFromCommand(["/usr/local/bin/aider"])).toBe("aider");
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
    expect(resolveAdapter({ command: ["aider"] })).toBe(AIDER_ADAPTER);
  });

  it("falls back to the generic adapter when nothing matches", () => {
    expect(resolveAdapter({ command: ["mystery-cli"] })).toBe(GENERIC_ADAPTER);
    expect(resolveAdapter({})).toBe(GENERIC_ADAPTER);
  });

  it("exposes every AgentTool in the registry", () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual(["aider", "claude-code", "codex-cli", "generic"]);
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

  it("Aider adapter parses litellm's 'Retrying in Ns' backoff notice", () => {
    const result = AIDER_ADAPTER.detectRateLimit("litellm.RateLimitError: overloaded\nRetrying in 8 seconds... (1/5)", {
      now,
    });
    expect(result?.pattern).toBe("aider-retrying-seconds");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 8_000).toISOString());
  });

  it("Aider adapter rounds a fractional backoff up to whole ms", () => {
    // 0.2s -> exactly 200ms; a "(1/5)" retry counter must not confuse the match.
    expect(AIDER_ADAPTER.detectRateLimit("Retrying in 0.2 seconds...", { now })?.resetAt).toBe(
      new Date(now.getTime() + 200).toISOString()
    );
  });

  it("Aider adapter also handles the OpenAI-style seconds wait via the shared pattern", () => {
    const result = AIDER_ADAPTER.detectRateLimit("Rate limit reached for gpt-4o. Please try again in 20s.", { now });
    expect(result?.pattern).toBe("codex-relative-seconds");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 20_000).toISOString());
  });

  it("Aider adapter still falls back to the generic patterns", () => {
    const result = AIDER_ADAPTER.detectRateLimit("Usage limit reached. Resets in 30m.", { now });
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 30 * 60_000).toISOString());
  });

  it("neither the generic nor the Codex adapter recognizes 'Retrying in Ns' — the gap Aider fills", () => {
    // The whole point of the Aider pattern: "Retry*ing*" breaks the Codex
    // seconds regex (its `retry` alternative needs whitespace right after), and
    // the generic parser has no seconds pattern at all.
    expect(GENERIC_ADAPTER.detectRateLimit("Retrying in 8 seconds...", { now })).toBeNull();
    expect(CODEX_CLI_ADAPTER.detectRateLimit("Retrying in 8 seconds...", { now })).toBeNull();
  });
});
