import { describe, expect, it } from "vitest";
import { summarizeTools } from "./tools.js";
import type { RelayJob } from "./types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("summarizeTools", () => {
  it("returns an empty shape for no jobs", () => {
    expect(summarizeTools([])).toEqual({ total: 0, toolCount: 0, tools: [] });
  });

  it("groups jobs by tool and counts active vs terminal", () => {
    const summary = summarizeTools([
      job({ tool: "claude-code", status: "completed" }),
      job({ tool: "claude-code", status: "queued" }),
      job({ tool: "codex-cli", status: "failed" }),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.toolCount).toBe(2);

    const claude = summary.tools.find((t) => t.tool === "claude-code");
    const codex = summary.tools.find((t) => t.tool === "codex-cli");
    expect(claude).toMatchObject({ total: 2, active: 1, terminal: 1, waiting: 0 });
    expect(codex).toMatchObject({ total: 1, active: 0, terminal: 1, waiting: 0, failed: 1 });
  });

  it("only rows tools that appear (no zero-fill of the fixed tool set)", () => {
    const summary = summarizeTools([job({ tool: "generic", status: "completed" })]);
    expect(summary.toolCount).toBe(1);
    expect(summary.tools.map((t) => t.tool)).toEqual(["generic"]);
  });

  it("classifies each status as active or terminal correctly", () => {
    const summary = summarizeTools([
      job({ tool: "generic", status: "queued" }),
      job({ tool: "generic", status: "waiting_for_reset" }),
      job({ tool: "generic", status: "resuming" }),
      job({ tool: "generic", status: "completed" }),
      job({ tool: "generic", status: "failed" }),
      job({ tool: "generic", status: "cancelled" }),
    ]);
    const g = summary.tools[0];
    expect(g.total).toBe(6);
    expect(g.active).toBe(3); // queued + waiting_for_reset + resuming
    expect(g.terminal).toBe(3); // completed + failed + cancelled
    expect(g.waiting).toBe(1); // only waiting_for_reset
    expect(g.completed).toBe(1);
    expect(g.failed).toBe(1);
    expect(g.cancelled).toBe(1);
  });

  it("derives successRate from completed/(completed+failed), excluding cancelled", () => {
    const summary = summarizeTools([
      job({ tool: "claude-code", status: "completed" }),
      job({ tool: "claude-code", status: "completed" }),
      job({ tool: "claude-code", status: "completed" }),
      job({ tool: "claude-code", status: "failed" }),
      job({ tool: "claude-code", status: "cancelled" }), // must not lower the rate
    ]);
    expect(summary.tools[0].successRate).toBeCloseTo(0.75, 5);
  });

  it("leaves successRate null when nothing has resolved yet", () => {
    const summary = summarizeTools([
      job({ tool: "codex-cli", status: "queued" }),
      job({ tool: "codex-cli", status: "waiting_for_reset" }),
      job({ tool: "codex-cli", status: "cancelled" }), // cancelled is excluded, so still unresolved
    ]);
    expect(summary.tools[0].successRate).toBeNull();
  });

  it("picks the earliest resetAt among waiting jobs as nextResetAt", () => {
    const summary = summarizeTools([
      job({ tool: "generic", status: "waiting_for_reset", resetAt: "2026-07-13T18:00:00.000Z" }),
      job({ tool: "generic", status: "waiting_for_reset", resetAt: "2026-07-13T15:00:00.000Z" }),
      // a resetAt on a non-waiting job must not count
      job({ tool: "generic", status: "resuming", resetAt: "2026-07-13T09:00:00.000Z" }),
    ]);
    expect(summary.tools[0].nextResetAt).toBe("2026-07-13T15:00:00.000Z");
  });

  it("leaves nextResetAt null when no job waits (or waiting jobs lack a resetAt)", () => {
    const summary = summarizeTools([
      job({ tool: "generic", status: "completed" }),
      job({ tool: "generic", status: "waiting_for_reset", resetAt: null }),
    ]);
    expect(summary.tools[0].nextResetAt).toBeNull();
    expect(summary.tools[0].waiting).toBe(1);
  });

  it("tracks the most recent updatedAt as lastActivityAt", () => {
    const summary = summarizeTools([
      job({ tool: "generic", updatedAt: "2026-07-13T01:00:00.000Z" }),
      job({ tool: "generic", updatedAt: "2026-07-13T05:00:00.000Z" }),
      job({ tool: "generic", updatedAt: "2026-07-13T03:00:00.000Z" }),
    ]);
    expect(summary.tools[0].lastActivityAt).toBe("2026-07-13T05:00:00.000Z");
  });

  it("ranks by active desc, then total desc, then name asc", () => {
    const summary = summarizeTools([
      // generic: 1 active, 3 total
      job({ tool: "generic", status: "queued" }),
      job({ tool: "generic", status: "completed" }),
      job({ tool: "generic", status: "completed" }),
      // claude-code: 2 active, 2 total (most pending → top)
      job({ tool: "claude-code", status: "queued" }),
      job({ tool: "claude-code", status: "resuming" }),
      // codex-cli: 1 active, 1 total (ties generic on active, loses on total; name asc vs generic)
      job({ tool: "codex-cli", status: "queued" }),
    ]);
    expect(summary.tools.map((t) => t.tool)).toEqual(["claude-code", "generic", "codex-cli"]);
  });
});
