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

  it("infers the gemini adapter from the command", () => {
    expect(resolveAdapter({ command: ["gemini", "-p", "x"] })).toBe(GEMINI_CLI_ADAPTER);
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

  it("Gemini adapter parses Google's retryDelay quota field the generic parser misses", () => {
    // The JSON form a 429 RESOURCE_EXHAUSTED surfaces.
    const json =
      'Error: 429 RESOURCE_EXHAUSTED — {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"17s"}]}}';
    const result = GEMINI_CLI_ADAPTER.detectRateLimit(json, { now });
    expect(result?.pattern).toBe("gemini-retry-delay");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 17_000).toISOString());
    // The generic parser has no notion of retryDelay, so it sees nothing.
    expect(GENERIC_ADAPTER.detectRateLimit(json, { now })).toBeNull();
  });

  it("Gemini adapter accepts snake_case and bare retry_delay forms", () => {
    expect(GEMINI_CLI_ADAPTER.detectRateLimit("retry_delay: 5s", { now })?.resetAt).toBe(
      new Date(now.getTime() + 5_000).toISOString()
    );
    expect(GEMINI_CLI_ADAPTER.detectRateLimit("retryDelay=30s", { now })?.resetAt).toBe(
      new Date(now.getTime() + 30_000).toISOString()
    );
  });

  it("Gemini adapter parses plain seconds waits and rounds fractional up", () => {
    const secs = GEMINI_CLI_ADAPTER.detectRateLimit("Please retry after 30 seconds.", { now });
    expect(secs?.pattern).toBe("gemini-relative-seconds");
    expect(secs?.resetAt).toBe(new Date(now.getTime() + 30_000).toISOString());
    // 0.4001s -> 401ms so we never resume before the wait elapses.
    expect(GEMINI_CLI_ADAPTER.detectRateLimit("try again in 0.4001s", { now })?.resetAt).toBe(
      new Date(now.getTime() + 401).toISOString()
    );
  });

  it("Gemini adapter still falls back to the generic hour/minute patterns", () => {
    const result = GEMINI_CLI_ADAPTER.detectRateLimit("Quota exceeded. Resets in 2h.", { now });
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 2 * 60 * 60_000).toISOString());
  });

  it("a zero-second retryDelay does not park a job with a right-now reset", () => {
    expect(GEMINI_CLI_ADAPTER.detectRateLimit("retryDelay: 0s", { now })).toBeNull();
  });
});
