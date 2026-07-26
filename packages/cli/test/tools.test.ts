import type { AdapterSummary } from "@agentrelay/core";
import { summarizeAdapters } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_JOBS_NOTE, NO_SCOPE_MATCH_MESSAGE, renderTools, renderToolsJson } from "../src/tools.js";

// `renderTools` defaults to `color: false`, so its output is already plain text
// (no ANSI escapes) — assertions read it directly.

describe("renderTools", () => {
  it("lists every adapter with binaries and pattern info for an empty store", () => {
    const out = renderTools(summarizeAdapters([]));
    expect(out).toContain(NO_JOBS_NOTE);
    expect(out).toContain("Claude Code [claude-code]");
    expect(out).toContain("binaries: claude, claude-code");
    expect(out).toContain("Codex CLI [codex-cli]");
    // Codex has a tool-specific pattern; Claude relies on the generic parser.
    expect(out).toContain("1 tool-specific (codex-relative-seconds)");
    expect(out).toContain("generic parser only");
    expect(out).toContain("(explicit --tool only)");
  });

  it("shows job counts and active subset when jobs exist", () => {
    const summary: AdapterSummary = {
      total: 3,
      adapters: [
        {
          tool: "claude-code",
          displayName: "Claude Code",
          binaries: ["claude", "claude-code"],
          patternCount: 0,
          patternNames: [],
          jobs: 2,
          activeJobs: 1,
        },
        {
          tool: "codex-cli",
          displayName: "Codex CLI",
          binaries: ["codex", "codex-cli"],
          patternCount: 1,
          patternNames: ["codex-relative-seconds"],
          jobs: 1,
          activeJobs: 0,
        },
      ],
      unknownTools: [],
    };
    const out = renderTools(summary);
    expect(out).toContain("2 adapter(s) registered");
    expect(out).toContain("(3 job(s) tracked)");
    expect(out).toContain("2 job(s) (1 active)");
    // No parenthetical "active" when the count is zero.
    expect(out).toMatch(/Codex CLI \[codex-cli]\s+1 job\(s\)\n/);
  });

  it("renders an unregistered-tools block when present", () => {
    const summary = summarizeAdapters([]);
    summary.unknownTools = [{ tool: "mystery", jobs: 2 }];
    const out = renderTools(summary);
    expect(out).toContain("Unregistered tool ids found on jobs:");
    expect(out).toContain("mystery  2 job(s)");
  });

  it("shows the scope note and the no-match message when a filter empties the store", () => {
    const out = renderTools(summarizeAdapters([]), { scopeNote: "tool=codex-cli" });
    expect(out).toContain("scope: tool=codex-cli");
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
  });
});

describe("renderToolsJson", () => {
  it("wraps the summary in the shared envelope", () => {
    const summary = summarizeAdapters([]);
    const json = JSON.parse(
      renderToolsJson({
        storePath: "/tmp/jobs.json",
        generatedAt: "2026-07-26T00:00:00.000Z",
        scope: { tools: ["codex-cli"] },
        summary,
      })
    );
    expect(json.storePath).toBe("/tmp/jobs.json");
    expect(json.generatedAt).toBe("2026-07-26T00:00:00.000Z");
    expect(json.scope).toEqual({ tools: ["codex-cli"] });
    expect(json.summary.adapters.map((a: { tool: string }) => a.tool)).toEqual(["claude-code", "codex-cli", "generic"]);
  });
});
