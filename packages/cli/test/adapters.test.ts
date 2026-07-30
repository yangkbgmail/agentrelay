import type { AdapterDescription } from "@agentrelay/core";
import { describeAdapters, GENERIC_PATTERN_NAMES } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { renderAdapters, renderAdaptersJson } from "../src/adapters.js";

const ADAPTERS = describeAdapters();

describe("renderAdapters", () => {
  it("lists every adapter's tool id", () => {
    const out = renderAdapters(ADAPTERS, GENERIC_PATTERN_NAMES);
    for (const a of ADAPTERS) {
      expect(out).toContain(a.tool);
      expect(out).toContain(a.displayName);
    }
  });

  it("shows the header with the adapter count", () => {
    const out = renderAdapters(ADAPTERS, GENERIC_PATTERN_NAMES);
    expect(out).toContain(`${ADAPTERS.length} adapter(s)`);
  });

  it("marks the default adapter", () => {
    const out = renderAdapters(ADAPTERS, GENERIC_PATTERN_NAMES);
    expect(out).toContain("(default)");
  });

  it("shows a binaries line and the generic-only note for adapters without binaries", () => {
    const generic: AdapterDescription = {
      tool: "generic",
      displayName: "Generic agent",
      binaries: [],
      extraPatterns: [],
      isDefault: true,
    };
    const out = renderAdapters([generic], GENERIC_PATTERN_NAMES);
    expect(out).toContain("inferred from --tool only");
    expect(out).toContain("generic patterns only");
  });

  it("lists adapter-specific patterns when present", () => {
    const codex = ADAPTERS.find((a) => a.tool === "codex-cli");
    if (!codex) throw new Error("codex adapter missing");
    const out = renderAdapters([codex], GENERIC_PATTERN_NAMES);
    expect(out).toContain("codex-relative-seconds");
  });

  it("always prints the shared generic vocabulary footer", () => {
    const out = renderAdapters(ADAPTERS, GENERIC_PATTERN_NAMES);
    expect(out).toContain("generic patterns (shared by all)");
    for (const name of GENERIC_PATTERN_NAMES) {
      expect(out).toContain(name);
    }
  });

  it("emits no ANSI codes when color is off", () => {
    const out = renderAdapters(ADAPTERS, GENERIC_PATTERN_NAMES, { color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI escapes are absent.
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("emits ANSI codes when color is on", () => {
    const out = renderAdapters(ADAPTERS, GENERIC_PATTERN_NAMES, { color: true });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI escapes are present.
    expect(out).toMatch(/\x1b\[/);
  });
});

describe("renderAdaptersJson", () => {
  it("produces a stable, parseable envelope", () => {
    const json = renderAdaptersJson({
      generatedAt: "2026-07-30T00:00:00.000Z",
      adapters: ADAPTERS,
      genericPatterns: GENERIC_PATTERN_NAMES,
    });
    const parsed = JSON.parse(json);
    expect(parsed.generatedAt).toBe("2026-07-30T00:00:00.000Z");
    expect(parsed.adapters).toEqual(ADAPTERS);
    expect(parsed.genericPatterns).toEqual([...GENERIC_PATTERN_NAMES]);
  });
});
