import type { RelayJob } from "@agentrelay/core";
import { summarizeTools } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_SCOPE_MATCH_MESSAGE, renderTools, renderToolsJson } from "../src/tools.js";

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
  it("lists every registered adapter even for an empty store", () => {
    const out = renderTools(summarizeTools([]), { now: NOW });
    expect(out).toContain("0 tool(s) with jobs");
    expect(out).toContain("3 adapter(s) registered");
    expect(out).toContain("claude-code");
    expect(out).toContain("Claude Code — binaries: claude, claude-code");
    expect(out).toContain("(no jobs)");
  });

  it("shows the no-match message for an empty scoped subset", () => {
    const out = renderTools(summarizeTools([]), { scopeNote: "project=nope" });
    expect(out).toContain("scope: project=nope");
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
  });

  it("renders per-tool counts", () => {
    const out = renderTools(
      summarizeTools([
        job({ tool: "claude-code", status: "completed" }),
        job({ tool: "claude-code", status: "queued" }),
        job({ tool: "codex-cli", status: "failed" }),
      ]),
      { now: NOW }
    );
    expect(out).toContain("2 tool(s) with jobs");
    expect(out).toContain("Codex CLI — binaries: codex, codex-cli");
  });

  it("shows the soonest reset with a countdown for a waiting tool", () => {
    const out = renderTools(
      summarizeTools([job({ tool: "claude-code", status: "waiting_for_reset", resetAt: "2026-07-12T18:00:00.000Z" })]),
      { now: NOW }
    );
    expect(out).toContain("2026-07-12T18:00:00.000Z");
    expect(out).toContain("(in 6h 0m)");
  });

  it("marks an unregistered tool id", () => {
    const out = renderTools(summarizeTools([job({ tool: "aider" as RelayJob["tool"], status: "completed" })]), {
      now: NOW,
    });
    expect(out).toContain("aider");
    expect(out).toContain("— unregistered");
  });

  it("echoes an active scope note once at the top", () => {
    const out = renderTools(summarizeTools([job({ tool: "claude-code" })]), {
      scopeNote: "status=completed",
      now: NOW,
    });
    expect(out).toContain("scope: status=completed");
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
    expect(parsed.scope).toBeUndefined();
    expect(parsed.summary.registeredCount).toBe(3);
    const claude = parsed.summary.tools.find((t: { tool: string }) => t.tool === "claude-code");
    expect(claude.active).toBe(1);
    expect(claude.binaries).toEqual(["claude", "claude-code"]);
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
