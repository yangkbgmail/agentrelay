import { describeAdapters } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { renderAdapters, renderAdaptersJson } from "../src/adapters.js";

describe("renderAdapters", () => {
  const adapters = describeAdapters();

  it("lists every adapter with a count header", () => {
    const out = renderAdapters(adapters, { color: false });
    expect(out).toContain(`${adapters.length} agent adapter(s)`);
    expect(out).toContain("claude-code");
    expect(out).toContain("codex-cli");
    expect(out).toContain("generic");
  });

  it("shows the binaries that auto-infer each adapter", () => {
    const out = renderAdapters(adapters, { color: false });
    expect(out).toContain("`claude`, `claude-code`");
    expect(out).toContain("`codex`, `codex-cli`");
  });

  it("shows tool-specific patterns and marks generic as the default fallback", () => {
    const out = renderAdapters(adapters, { color: false });
    expect(out).toContain("codex-relative-seconds");
    expect(out).toContain("(default fallback)");
    // The generic adapter has no inferring binaries.
    expect(out).toContain("(none — explicit --tool only)");
    // Adapters without extra patterns say so.
    expect(out).toContain("(generic parser only)");
  });

  it("emits no ANSI escapes when color is off, and does when on", () => {
    expect(renderAdapters(adapters, { color: false })).not.toContain("\x1b[");
    expect(renderAdapters(adapters, { color: true })).toContain("\x1b[");
  });

  it("does not leave a trailing blank line", () => {
    const out = renderAdapters(adapters, { color: false });
    expect(out.endsWith("\n")).toBe(false);
    expect(out.endsWith("")).toBe(true);
  });
});

describe("renderAdaptersJson", () => {
  it("wraps the full adapter list in an { adapters } envelope", () => {
    const adapters = describeAdapters();
    const parsed = JSON.parse(renderAdaptersJson(adapters));
    expect(parsed.adapters).toHaveLength(adapters.length);
    expect(parsed.adapters[0]).toHaveProperty("tool");
    expect(parsed.adapters[0]).toHaveProperty("extraPatterns");
    expect(parsed.adapters.find((a: { tool: string }) => a.tool === "generic").isDefault).toBe(true);
  });
});
