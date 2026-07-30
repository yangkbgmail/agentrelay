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
    expect(codex).toMatchObject({ total: 1, active: 0, terminal: 1, waiting: 0 });
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
  });

  it("only creates rows for tools actually present (no zero-filled enum)", () => {
    const summary = summarizeTools([job({ tool: "claude-code" })]);
    expect(summary.toolCount).toBe(1);
    expect(summary.tools.map((t) => t.tool)).toEqual(["claude-code"]);
  });

  it("picks the earliest resetAt among waiting_for_reset jobs", () => {
    const summary = summarizeTools([
      job({ tool: "codex-cli", status: "waiting_for_reset", resetAt: "2026-07-13T05:00:00.000Z" }),
      job({ tool: "codex-cli", status: "waiting_for_reset", resetAt: "2026-07-13T03:00:00.000Z" }),
      job({ tool: "codex-cli", status: "waiting_for_reset", resetAt: "2026-07-13T09:00:00.000Z" }),
    ]);
    expect(summary.tools[0].nextResetAt).toBe("2026-07-13T03:00:00.000Z");
    expect(summary.tools[0].waiting).toBe(3);
  });

  it("ignores resetAt on non-waiting jobs when picking nextResetAt", () => {
    const summary = summarizeTools([
      job({ tool: "claude-code", status: "completed", resetAt: "2026-07-13T01:00:00.000Z" }),
      job({ tool: "claude-code", status: "waiting_for_reset", resetAt: "2026-07-13T06:00:00.000Z" }),
    ]);
    expect(summary.tools[0].nextResetAt).toBe("2026-07-13T06:00:00.000Z");
  });

  it("tracks the most recent updatedAt as lastActivityAt", () => {
    const summary = summarizeTools([
      job({ tool: "generic", updatedAt: "2026-07-13T00:00:00.000Z" }),
      job({ tool: "generic", updatedAt: "2026-07-13T12:00:00.000Z" }),
      job({ tool: "generic", updatedAt: "2026-07-13T06:00:00.000Z" }),
    ]);
    expect(summary.tools[0].lastActivityAt).toBe("2026-07-13T12:00:00.000Z");
  });

  it("ranks by active desc, then total desc, then tool name asc", () => {
    const summary = summarizeTools([
      // generic: 0 active, 2 total
      job({ tool: "generic", status: "completed" }),
      job({ tool: "generic", status: "failed" }),
      // codex-cli: 1 active, 1 total
      job({ tool: "codex-cli", status: "queued" }),
      // claude-code: 1 active, 3 total
      job({ tool: "claude-code", status: "queued" }),
      job({ tool: "claude-code", status: "completed" }),
      job({ tool: "claude-code", status: "completed" }),
    ]);
    // claude-code and codex-cli both have 1 active; claude-code wins on total (3 vs 1);
    // generic (0 active) sorts last despite having 2 total.
    expect(summary.tools.map((t) => t.tool)).toEqual(["claude-code", "codex-cli", "generic"]);
  });

  it("breaks a full active+total tie on tool name ascending", () => {
    const summary = summarizeTools([
      job({ tool: "generic", status: "queued" }),
      job({ tool: "codex-cli", status: "queued" }),
    ]);
    // both 1 active / 1 total -> name asc: codex-cli before generic
    expect(summary.tools.map((t) => t.tool)).toEqual(["codex-cli", "generic"]);
  });

  it("does not mutate the input and leaves nextResetAt null when nothing waits", () => {
    const jobs = [job({ tool: "claude-code", status: "completed" })];
    const snapshot = JSON.stringify(jobs);
    const summary = summarizeTools(jobs);
    expect(summary.tools[0].nextResetAt).toBeNull();
    expect(JSON.stringify(jobs)).toBe(snapshot);
  });
});
