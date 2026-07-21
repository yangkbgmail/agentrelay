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
    expect(inferToolFromCommand(["/opt/bin/gemini-cli"])).toBe("gemini-cli");
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
    expect(resolveAdapter({ command: ["gemini"] })).toBe(GEMINI_CLI_ADAPTER);
  });

  it("falls back to the generic adapter when nothing matches", () => {
    expect(resolveAdapter({ command: ["mystery-cli"] })).toBe(GENERIC_ADAPTER);
    expect(resolveAdapter({})).toBe(GENERIC_ADAPTER);
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

  it("Gemini adapter parses the RESOURCE_EXHAUSTED retryDelay field", () => {
    const payload =
      'got status: 429. {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"},' +
      '"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"56s"}]}';
    const result = GEMINI_CLI_ADAPTER.detectRateLimit(payload, { now });
    expect(result?.pattern).toBe("gemini-retry-delay");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 56_000).toISOString());
  });

  it("Gemini adapter accepts unquoted / spaced retry-delay forms and minutes", () => {
    // Unquoted, `=` separator, spaced value.
    expect(GEMINI_CLI_ADAPTER.detectRateLimit("retry_delay = 30 s", { now })?.resetAt).toBe(
      new Date(now.getTime() + 30_000).toISOString()
    );
    // Minutes unit.
    expect(GEMINI_CLI_ADAPTER.detectRateLimit('"retryDelay": "2m"', { now })?.resetAt).toBe(
      new Date(now.getTime() + 2 * 60_000).toISOString()
    );
  });

  it("Gemini adapter rounds fractional seconds up so it never resumes early", () => {
    expect(GEMINI_CLI_ADAPTER.detectRateLimit('retryDelay: "0.4001s"', { now })?.resetAt).toBe(
      new Date(now.getTime() + 401).toISOString()
    );
  });

  it("Gemini adapter ignores ambiguous millisecond delays", () => {
    // "230ms" must NOT be misread as 230s or 230m — sub-second, not worth a resume.
    expect(GEMINI_CLI_ADAPTER.detectRateLimit('retryDelay: "230ms"', { now })).toBeNull();
  });

  it("Gemini adapter still falls back to the generic patterns", () => {
    const result = GEMINI_CLI_ADAPTER.detectRateLimit("Usage limit reached. Resets in 15m.", { now });
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 15 * 60_000).toISOString());
  });

  it("the generic adapter does NOT understand the retryDelay field", () => {
    // The structured retry hint is Gemini-specific; the generic parser skips it.
    expect(GENERIC_ADAPTER.detectRateLimit('retryDelay: "56s"', { now })).toBeNull();
  });

  it("the Claude Code adapter behaves like the generic parser", () => {
    const text = "usage limit reached, resets at 2026-07-13T05:00:00Z";
    expect(CLAUDE_CODE_ADAPTER.detectRateLimit(text, { now })?.pattern).toBe("iso-timestamp");
  });
});
