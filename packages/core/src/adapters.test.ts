import { describe, expect, it } from "vitest";
import { ADAPTERS, DEFAULT_ADAPTER_TOOL, describeAdapters } from "./adapters.js";
import { GENERIC_PATTERN_NAMES } from "./parser.js";
import type { AgentTool } from "./types.js";

describe("describeAdapters", () => {
  it("describes every registered adapter, in registry order", () => {
    const described = describeAdapters();
    expect(described.map((a) => a.tool)).toEqual(Object.keys(ADAPTERS) as AgentTool[]);
  });

  it("carries display name and binaries from the registry", () => {
    const claude = describeAdapters().find((a) => a.tool === "claude-code");
    expect(claude?.displayName).toBe("Claude Code");
    expect(claude?.binaries).toEqual(["claude", "claude-code"]);
  });

  it("lists adapter-specific pattern names (Codex adds a seconds pattern)", () => {
    const codex = describeAdapters().find((a) => a.tool === "codex-cli");
    expect(codex?.extraPatterns).toEqual(["codex-relative-seconds"]);
  });

  it("reports no extra patterns for adapters that rely only on the generic parser", () => {
    const claude = describeAdapters().find((a) => a.tool === "claude-code");
    expect(claude?.extraPatterns).toEqual([]);
    const generic = describeAdapters().find((a) => a.tool === "generic");
    expect(generic?.extraPatterns).toEqual([]);
  });

  it("flags exactly the generic adapter as the default", () => {
    const described = describeAdapters();
    const defaults = described.filter((a) => a.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].tool).toBe(DEFAULT_ADAPTER_TOOL);
    expect(DEFAULT_ADAPTER_TOOL).toBe("generic");
  });

  it("returns fresh copies — mutating the result cannot corrupt the registry", () => {
    const first = describeAdapters();
    first[0].binaries.push("tampered");
    first[0].extraPatterns.push("tampered");
    const second = describeAdapters();
    expect(second[0].binaries).not.toContain("tampered");
    expect(second[0].extraPatterns).not.toContain("tampered");
  });

  it("is JSON-round-trippable (plain data, no RegExp/functions)", () => {
    const described = describeAdapters();
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
  });
});

describe("GENERIC_PATTERN_NAMES", () => {
  it("exposes the known generic pattern vocabulary in try-order", () => {
    expect(GENERIC_PATTERN_NAMES).toContain("iso-timestamp");
    expect(GENERIC_PATTERN_NAMES).toContain("relative-duration");
    expect(GENERIC_PATTERN_NAMES).toContain("http-retry-after");
    // A stable, non-empty list — the shared vocabulary every adapter falls back to.
    expect(GENERIC_PATTERN_NAMES.length).toBeGreaterThan(0);
  });
});
