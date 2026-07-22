import type { ToolReport } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { renderToolsReport, renderToolsReportJson } from "../src/tools.js";

function report(overrides: Partial<ToolReport> = {}): ToolReport {
  return {
    totalJobs: 3,
    tools: [
      {
        tool: "claude-code",
        adapter: {
          tool: "claude-code",
          displayName: "Claude Code",
          binaries: ["claude", "claude-code"],
          patternNames: [],
        },
        jobCount: 1,
      },
      {
        tool: "codex-cli",
        adapter: {
          tool: "codex-cli",
          displayName: "Codex CLI",
          binaries: ["codex", "codex-cli"],
          patternNames: ["codex-relative-seconds"],
        },
        jobCount: 2,
      },
      {
        tool: "generic",
        adapter: { tool: "generic", displayName: "Generic agent", binaries: [], patternNames: [] },
        jobCount: 0,
      },
    ],
    ...overrides,
  };
}

describe("renderToolsReport", () => {
  it("lists each adapter with binaries, patterns and job counts (no color by default)", () => {
    const out = renderToolsReport(report());
    expect(out).toContain("Supported agent tools (3)");
    expect(out).toContain("claude-code");
    expect(out).toContain("binaries: claude, claude-code");
    // codex has a custom pattern; claude/generic fall back to generic parser.
    expect(out).toContain("codex-relative-seconds");
    expect(out).toContain("generic only");
    expect(out).toContain("3 job(s) tracked");
    expect(out).not.toContain("\x1b[");
  });

  it("labels the binary-less generic adapter as a fallback", () => {
    const out = renderToolsReport(report());
    expect(out).toContain("fallback");
  });

  it("emits ANSI codes only when color is enabled", () => {
    expect(renderToolsReport(report(), { color: true })).toContain("\x1b[");
  });

  it("renders an unregistered store-only tool distinctly", () => {
    const out = renderToolsReport(
      report({
        totalJobs: 1,
        tools: [{ tool: "future-agent", adapter: null, jobCount: 1 }],
      })
    );
    // Only registered adapters count toward the header total.
    expect(out).toContain("Supported agent tools (0)");
    expect(out).toContain("future-agent");
    expect(out).toContain("unregistered");
  });
});

describe("renderToolsReportJson", () => {
  it("emits a machine-readable object with store path and injected timestamp", () => {
    const json = renderToolsReportJson(report(), "/tmp/jobs.json", { generatedAt: "2026-07-22T00:00:00.000Z" });
    const parsed = JSON.parse(json);
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-22T00:00:00.000Z");
    expect(parsed.totalJobs).toBe(3);
    expect(parsed.tools).toHaveLength(3);
    expect(parsed.tools[1].tool).toBe("codex-cli");
    expect(parsed.tools[1].adapter.patternNames).toEqual(["codex-relative-seconds"]);
  });
});
