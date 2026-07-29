import { summarizeAdapters } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { renderAdapters, renderAdaptersJson } from "../src/adapters.js";

const SUMMARY = summarizeAdapters();

describe("renderAdapters", () => {
  it("lists every registered adapter with its display name and tool id", () => {
    const out = renderAdapters(SUMMARY);
    expect(out).toContain("Claude Code");
    expect(out).toContain("[claude-code]");
    expect(out).toContain("Codex CLI");
    expect(out).toContain("[codex-cli]");
    expect(out).toContain("Generic agent");
    expect(out).toContain("[generic]");
  });

  it("shows the argv[0] binaries that auto-select an adapter", () => {
    const out = renderAdapters(SUMMARY);
    expect(out).toContain("binaries: claude, claude-code");
    expect(out).toContain("binaries: codex, codex-cli");
  });

  it("marks the generic adapter as the default fallback with no binaries", () => {
    const out = renderAdapters(SUMMARY);
    const genericLine = out.split("\n").find((l) => l.includes("[generic]"));
    expect(genericLine).toContain("(default)");
    expect(out).toContain("fallback when no tool matches");
  });

  it("lists an adapter's extra patterns and notes generic-only adapters", () => {
    const out = renderAdapters(SUMMARY);
    expect(out).toContain("extra patterns: codex-relative-seconds");
    expect(out).toContain("uses generic patterns only");
  });

  it("shows the shared generic patterns section", () => {
    const out = renderAdapters(SUMMARY);
    expect(out).toContain("Generic patterns");
    expect(out).toContain("iso-timestamp");
    expect(out).toContain("relative-duration");
  });

  it("emits no ANSI codes when color is off", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderAdapters(SUMMARY, { color: false })).not.toMatch(/\x1b\[/);
  });

  it("emits ANSI codes when color is on", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI escapes are present.
    expect(renderAdapters(SUMMARY, { color: true })).toMatch(/\x1b\[/);
  });
});

describe("renderAdaptersJson", () => {
  it("produces valid JSON with generatedAt and the full summary", () => {
    const parsed = JSON.parse(renderAdaptersJson({ generatedAt: "2026-07-29T00:00:00.000Z", summary: SUMMARY }));
    expect(parsed.generatedAt).toBe("2026-07-29T00:00:00.000Z");
    expect(parsed.summary.adapters.map((a: { tool: string }) => a.tool)).toEqual([
      "claude-code",
      "codex-cli",
      "generic",
    ]);
    expect(parsed.summary.genericPatterns).toContain("iso-timestamp");
  });
});
