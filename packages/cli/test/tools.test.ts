import type { RelayJob } from "@agentrelay/core";
import { summarizeTools } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_SCOPE_MATCH_MESSAGE, NO_TOOLS_MESSAGE, renderTools, renderToolsJson } from "../src/tools.js";

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
    const out = renderTools(summarizeTools([]), { scopeNote: "tool=codex-cli" });
    expect(out).toContain("scope: tool=codex-cli");
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

  it("renders the success rate as a percentage", () => {
    const out = renderTools(
      summarizeTools([
        job({ tool: "claude-code", status: "completed" }),
        job({ tool: "claude-code", status: "completed" }),
        job({ tool: "claude-code", status: "completed" }),
        job({ tool: "claude-code", status: "failed" }),
      ]),
      { now: NOW }
    );
    expect(out).toContain("75%");
  });

  it("shows n/a for a tool with nothing resolved yet", () => {
    const out = renderTools(summarizeTools([job({ tool: "codex-cli", status: "queued" })]), { now: NOW });
    expect(out).toContain("n/a");
  });

  it("shows the soonest reset with a countdown for a waiting tool", () => {
    const out = renderTools(
      summarizeTools([job({ tool: "generic", status: "waiting_for_reset", resetAt: "2026-07-12T18:00:00.000Z" })]),
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
