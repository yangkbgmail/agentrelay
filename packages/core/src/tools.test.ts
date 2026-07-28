import { describe, expect, it } from "vitest";
import { type AgentAdapter, CLAUDE_CODE_ADAPTER, CODEX_CLI_ADAPTER, GENERIC_ADAPTER } from "./adapters.js";
import { GENERIC_PARSER_PATTERNS } from "./parser.js";
import { describeAdapters } from "./tools.js";

describe("describeAdapters", () => {
  it("describes every registered adapter", () => {
    const described = describeAdapters();
    const tools = described.map((d) => d.tool);
    expect(tools).toContain("claude-code");
    expect(tools).toContain("codex-cli");
    expect(tools).toContain("generic");
    expect(described).toHaveLength(3);
  });

  it("sinks the generic adapter to the bottom, keeping specific tools first", () => {
    const described = describeAdapters();
    expect(described[described.length - 1].tool).toBe("generic");
    // Specific adapters (registry order) come before the fallback.
    expect(described.slice(0, -1).every((d) => !d.isGeneric)).toBe(true);
  });

  it("flags only the generic adapter as generic", () => {
    const byTool = new Map(describeAdapters().map((d) => [d.tool, d]));
    expect(byTool.get("generic")?.isGeneric).toBe(true);
    expect(byTool.get("claude-code")?.isGeneric).toBe(false);
    expect(byTool.get("codex-cli")?.isGeneric).toBe(false);
  });

  it("surfaces inferring binaries per adapter", () => {
    const byTool = new Map(describeAdapters().map((d) => [d.tool, d]));
    expect(byTool.get("claude-code")?.binaries).toEqual(CLAUDE_CODE_ADAPTER.binaries);
    expect(byTool.get("codex-cli")?.binaries).toEqual(CODEX_CLI_ADAPTER.binaries);
    expect(byTool.get("generic")?.binaries).toEqual([]);
  });

  it("lists tool-specific pattern names (codex adds a seconds pattern; claude/generic add none)", () => {
    const byTool = new Map(describeAdapters().map((d) => [d.tool, d]));
    expect(byTool.get("codex-cli")?.extraPatterns).toEqual(CODEX_CLI_ADAPTER.patterns.map((p) => p.name));
    expect(byTool.get("codex-cli")?.extraPatterns).toContain("codex-relative-seconds");
    expect(byTool.get("claude-code")?.extraPatterns).toEqual([]);
    expect(byTool.get("generic")?.extraPatterns).toEqual([]);
  });

  it("returns copies, not references to the adapter's own arrays", () => {
    const described = describeAdapters();
    const codex = described.find((d) => d.tool === "codex-cli");
    expect(codex).toBeDefined();
    codex?.binaries.push("mutated");
    expect(CODEX_CLI_ADAPTER.binaries).not.toContain("mutated");
  });

  it("orders a custom registry with generic last regardless of insertion order", () => {
    const custom: Record<string, AgentAdapter> = {
      generic: GENERIC_ADAPTER,
      "claude-code": CLAUDE_CODE_ADAPTER,
      "codex-cli": CODEX_CLI_ADAPTER,
      // biome-ignore lint/suspicious/noExplicitAny: exercising the sort with a non-default registry
    } as any;
    const described = describeAdapters(custom as never);
    expect(described[described.length - 1].tool).toBe("generic");
  });
});

describe("GENERIC_PARSER_PATTERNS", () => {
  it("exposes the built-in pattern names in priority order", () => {
    expect(GENERIC_PARSER_PATTERNS[0]).toBe("iso-timestamp");
    expect(GENERIC_PARSER_PATTERNS).toContain("relative-duration");
    expect(GENERIC_PARSER_PATTERNS).toContain("http-retry-after");
    expect(GENERIC_PARSER_PATTERNS.length).toBeGreaterThanOrEqual(5);
  });
});
