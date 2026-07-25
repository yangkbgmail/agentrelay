import { describeAdapters } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { renderTools, renderToolsJson } from "../src/tools.js";

describe("renderTools", () => {
  it("lists every registered adapter's --tool id and display name", () => {
    const out = renderTools(describeAdapters());
    expect(out).toContain("claude-code");
    expect(out).toContain("Claude Code");
    expect(out).toContain("codex-cli");
    expect(out).toContain("Codex CLI");
    expect(out).toContain("generic");
    expect(out).toContain("Generic agent");
  });

  it("shows the inferring binaries for a tool", () => {
    const out = renderTools(describeAdapters());
    const codexLine = out.split("\n").find((l, i, arr) => arr[i - 1]?.includes("codex-cli") && l.includes("binaries"));
    expect(codexLine).toContain("codex");
  });

  it("shows tool-specific pattern names and a placeholder for adapters without them", () => {
    const out = renderTools(describeAdapters());
    expect(out).toContain("codex-relative-seconds");
    // Claude Code / generic have no extra patterns → the generic-parser note.
    expect(out).toContain("generic parser only");
  });

  it("marks the generic adapter as the default fallback", () => {
    const out = renderTools(describeAdapters());
    const genericLine = out.split("\n").find((l) => l.includes("generic") && l.includes("Generic agent"));
    expect(genericLine).toContain("default");
  });

  it("emits no ANSI codes when color is off", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderTools(describeAdapters(), { color: false })).not.toMatch(/\x1b\[/);
  });

  it("emits ANSI codes when color is on", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI escapes are present.
    expect(renderTools(describeAdapters(), { color: true })).toMatch(/\x1b\[/);
  });
});

describe("renderToolsJson", () => {
  it("produces valid JSON with generatedAt and the adapter catalog", () => {
    const parsed = JSON.parse(renderToolsJson(describeAdapters(), "2026-07-25T00:00:00.000Z"));
    expect(parsed.generatedAt).toBe("2026-07-25T00:00:00.000Z");
    expect(parsed.adapters.map((a: { tool: string }) => a.tool)).toEqual(["claude-code", "codex-cli", "generic"]);
    const codex = parsed.adapters.find((a: { tool: string }) => a.tool === "codex-cli");
    expect(codex.patternNames).toEqual(["codex-relative-seconds"]);
    expect(codex.isFallback).toBe(false);
  });
});
