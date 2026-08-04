import type { RelayJob } from "@agentrelay/core";
import { summarizeTools } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  NO_SCOPE_MATCH_MESSAGE,
  NO_TOOLS_MESSAGE,
  renderTools,
  renderToolsJson,
  renderToolsWatchFrame,
} from "../src/tools.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `abcdef${seq}`,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

// A fixed "now" comfortably before the reset times below, for a stable countdown.
const NOW = Date.parse("2026-07-12T12:00:00.000Z");

describe("renderTools", () => {
  it("shows the onboarding message for an empty store", () => {
    expect(renderTools(summarizeTools([]))).toBe(NO_TOOLS_MESSAGE);
  });

  it("shows the no-match message for an empty scoped subset", () => {
    const out = renderTools(summarizeTools([]), { scopeNote: "project=web" });
    expect(out).toContain("scope: project=web");
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
  });

  it("renders a header and one row per tool", () => {
    const out = renderTools(
      summarizeTools([
        job({ tool: "claude-code", status: "completed" }),
        job({ tool: "claude-code", status: "queued" }),
        job({ tool: "codex-cli", status: "failed" }),
      ]),
      { now: NOW }
    );
    expect(out).toContain("2 tool(s)");
    expect(out).toContain("across 3 job(s)");
    expect(out).toContain("claude-code");
    expect(out).toContain("codex-cli");
  });

  it("shows the soonest reset with a countdown for a waiting tool", () => {
    const out = renderTools(
      summarizeTools([job({ tool: "claude-code", status: "waiting_for_reset", resetAt: "2026-07-12T18:00:00.000Z" })]),
      { now: NOW }
    );
    expect(out).toContain("2026-07-12T18:00:00.000Z");
    expect(out).toContain("(in 6h 0m)");
  });

  it("shows (idle) for a tool with only terminal jobs and no reset", () => {
    const out = renderTools(summarizeTools([job({ tool: "generic", status: "completed" })]), { now: NOW });
    expect(out).toContain("(idle)");
  });

  it("echoes an active scope note once at the top", () => {
    const out = renderTools(summarizeTools([job({ tool: "claude-code" })]), {
      scopeNote: "status=completed",
      now: NOW,
    });
    expect(out).toContain("scope: status=completed");
  });
});

describe("renderToolsWatchFrame", () => {
  it("prepends a live title with the store path, timestamp, and interval", () => {
    const out = renderToolsWatchFrame(summarizeTools([job({ tool: "claude-code" })]), "/tmp/jobs.json", 5000, NOW);
    const lines = out.split("\n");
    expect(lines[0]).toContain("agentrelay tools");
    expect(lines[0]).toContain("every 5s");
    expect(lines[0]).toContain("Ctrl-C to exit");
    expect(lines[1]).toContain("2026-07-12 12:00:00Z");
    expect(lines[1]).toContain("/tmp/jobs.json");
    expect(lines[2]).toBe("");
  });

  it("embeds the colored table body with a live countdown", () => {
    const out = renderToolsWatchFrame(
      summarizeTools([job({ tool: "claude-code", status: "waiting_for_reset", resetAt: "2026-07-12T18:00:00.000Z" })]),
      "/tmp/jobs.json",
      2000,
      NOW
    );
    expect(out).toContain("(in 6h 0m)");
    // Watch frames are always colored (live TTY view).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting escapes are present.
    expect(out).toMatch(/\x1b\[/);
  });

  it("carries the scope note into the frame body", () => {
    const out = renderToolsWatchFrame(summarizeTools([]), "/tmp/jobs.json", 2000, NOW, "project=ghost");
    expect(out).toContain("scope: project=ghost");
  });
});

describe("renderToolsJson", () => {
  it("wraps the summary in a stable envelope", () => {
    const summary = summarizeTools([job({ tool: "claude-code", status: "queued" })]);
    const json = renderToolsJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-12T12:00:00.000Z",
      summary,
    });
    const parsed = JSON.parse(json);
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-12T12:00:00.000Z");
    expect(parsed.scope).toBeUndefined();
    expect(parsed.summary.toolCount).toBe(1);
    expect(parsed.summary.tools[0].tool).toBe("claude-code");
    expect(parsed.summary.tools[0].active).toBe(1);
  });

  it("includes the scope when one is active", () => {
    const json = renderToolsJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-12T12:00:00.000Z",
      scope: { statuses: ["queued"] },
      summary: summarizeTools([]),
    });
    expect(JSON.parse(json).scope).toEqual({ statuses: ["queued"] });
  });
});
