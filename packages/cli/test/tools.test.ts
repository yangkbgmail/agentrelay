import { describeAdapters, GENERIC_PARSER_PATTERNS } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { renderTools, renderToolsJson } from "../src/tools.js";

const adapters = describeAdapters();

describe("renderTools", () => {
  it("lists every adapter with its binaries and patterns", () => {
    const out = renderTools(adapters, GENERIC_PARSER_PATTERNS);
    expect(out).toContain("3 agent tool adapter(s)");
    expect(out).toContain("claude-code");
    expect(out).toContain("Claude Code");
    expect(out).toContain("codex-cli");
    // codex binaries and its tool-specific pattern are surfaced
    expect(out).toContain("codex");
    expect(out).toContain("codex-relative-seconds");
  });

  it("marks the generic adapter as the fallback and shows its empty binaries", () => {
    const out = renderTools(adapters, GENERIC_PARSER_PATTERNS);
    expect(out).toContain("fallback");
    expect(out).toContain("never auto-inferred");
  });

  it("prints the shared generic patterns once at the bottom", () => {
    const out = renderTools(adapters, GENERIC_PARSER_PATTERNS);
    expect(out).toContain("generic patterns");
    expect(out).toContain("iso-timestamp");
    expect(out).toContain("relative-duration");
  });

  it("gates ANSI codes on the color flag", () => {
    expect(renderTools(adapters, GENERIC_PARSER_PATTERNS, { color: false })).not.toContain("\x1b[");
    expect(renderTools(adapters, GENERIC_PARSER_PATTERNS, { color: true })).toContain("\x1b[");
  });
});

describe("renderToolsJson", () => {
  it("emits the adapters and generic patterns as parseable JSON", () => {
    const json = JSON.parse(renderToolsJson({ adapters, genericPatterns: GENERIC_PARSER_PATTERNS }));
    expect(json.adapters.map((a: { tool: string }) => a.tool)).toContain("claude-code");
    expect(json.adapters[json.adapters.length - 1].tool).toBe("generic");
    expect(json.genericPatterns).toContain("iso-timestamp");
  });
});
