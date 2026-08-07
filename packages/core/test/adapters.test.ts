import { describe, expect, it } from "vitest";
import {
  ADAPTERS,
  CLAUDE_CODE_ADAPTER,
  CODEX_CLI_ADAPTER,
  GENERIC_ADAPTER,
  inferToolFromCommand,
  insertClaudeContinueFlag,
  resolveAdapter,
  resumeWithContextFromEnv,
} from "../src/adapters.js";

describe("inferToolFromCommand", () => {
  it("recognizes the claude binary", () => {
    expect(inferToolFromCommand(["claude", "-p", "continue"])).toBe("claude-code");
  });

  it("recognizes the codex binary", () => {
    expect(inferToolFromCommand(["codex", "exec", "fix the bug"])).toBe("codex-cli");
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

  it("exposes every AgentTool in the registry", () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual(["claude-code", "codex-cli", "generic"]);
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
});

describe("insertClaudeContinueFlag", () => {
  it("inserts --continue right after the claude binary", () => {
    expect(insertClaudeContinueFlag(["claude", "-p", "keep going"])).toEqual([
      "claude",
      "--continue",
      "-p",
      "keep going",
    ]);
  });

  it("inserts after the recognized binary even when wrapped (npx claude ...)", () => {
    expect(insertClaudeContinueFlag(["npx", "claude", "-p", "x"])).toEqual(["npx", "claude", "--continue", "-p", "x"]);
  });

  it("matches a path- or .exe-qualified binary", () => {
    expect(insertClaudeContinueFlag(["/usr/local/bin/claude", "-p", "x"])).toEqual([
      "/usr/local/bin/claude",
      "--continue",
      "-p",
      "x",
    ]);
  });

  it("is idempotent when a continue/resume flag is already present", () => {
    for (const flag of ["--continue", "-c", "--resume", "-r"]) {
      const cmd = ["claude", flag, "-p", "x"];
      expect(insertClaudeContinueFlag(cmd)).toEqual(cmd);
    }
  });

  it("leaves a command alone when the claude binary isn't present", () => {
    expect(insertClaudeContinueFlag(["some-wrapper", "-p", "x"])).toEqual(["some-wrapper", "-p", "x"]);
    expect(insertClaudeContinueFlag([])).toEqual([]);
  });
});

describe("adapter buildResumeCommand", () => {
  it("Claude Code adapter continues the previous session on resume", () => {
    expect(CLAUDE_CODE_ADAPTER.buildResumeCommand(["claude", "-p", "x"])).toEqual(["claude", "--continue", "-p", "x"]);
  });

  it("Codex and generic adapters re-run the command verbatim", () => {
    expect(CODEX_CLI_ADAPTER.buildResumeCommand(["codex", "exec", "x"])).toEqual(["codex", "exec", "x"]);
    expect(GENERIC_ADAPTER.buildResumeCommand(["mystery", "x"])).toEqual(["mystery", "x"]);
  });
});

describe("resumeWithContextFromEnv", () => {
  it("defaults to on when the env var is unset or blank", () => {
    expect(resumeWithContextFromEnv({})).toBe(true);
    expect(resumeWithContextFromEnv({ AGENTRELAY_RESUME_CONTINUE: "   " })).toBe(true);
  });

  it("turns off for falsy values (case/space-insensitive)", () => {
    for (const v of ["0", "false", "off", "no", " OFF ", "False"]) {
      expect(resumeWithContextFromEnv({ AGENTRELAY_RESUME_CONTINUE: v })).toBe(false);
    }
  });

  it("stays on for any other value", () => {
    for (const v of ["1", "true", "on", "yes"]) {
      expect(resumeWithContextFromEnv({ AGENTRELAY_RESUME_CONTINUE: v })).toBe(true);
    }
  });
});
