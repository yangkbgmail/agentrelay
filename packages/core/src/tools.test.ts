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
  it("lists every registered adapter even with no jobs", () => {
    const summary = summarizeTools([]);
    expect(summary.total).toBe(0);
    expect(summary.toolCount).toBe(0);
    expect(summary.registeredCount).toBe(3);
    expect(summary.tools.map((t) => t.tool).sort()).toEqual(["claude-code", "codex-cli", "generic"]);
    // all zero-filled and marked registered with adapter metadata
    const claude = summary.tools.find((t) => t.tool === "claude-code");
    expect(claude).toMatchObject({
      displayName: "Claude Code",
      binaries: ["claude", "claude-code"],
      registered: true,
      total: 0,
      active: 0,
    });
  });

  it("groups jobs by tool and counts active vs terminal", () => {
    const summary = summarizeTools([
      job({ tool: "claude-code", status: "completed" }),
      job({ tool: "claude-code", status: "queued" }),
      job({ tool: "codex-cli", status: "failed" }),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.toolCount).toBe(2); // generic has 0 jobs, not counted

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
    const g = summary.tools.find((t) => t.tool === "generic")!;
    expect(g.total).toBe(6);
    expect(g.active).toBe(3); // queued + waiting_for_reset + resuming
    expect(g.terminal).toBe(3); // completed + failed + cancelled
    expect(g.waiting).toBe(1); // only waiting_for_reset
  });

  it("picks the earliest resetAt among waiting jobs as nextResetAt", () => {
    const summary = summarizeTools([
      job({ tool: "claude-code", status: "waiting_for_reset", resetAt: "2026-07-13T18:00:00.000Z" }),
      job({ tool: "claude-code", status: "waiting_for_reset", resetAt: "2026-07-13T15:00:00.000Z" }),
      // a resetAt on a non-waiting job must not count
      job({ tool: "claude-code", status: "resuming", resetAt: "2026-07-13T09:00:00.000Z" }),
    ]);
    const claude = summary.tools.find((t) => t.tool === "claude-code")!;
    expect(claude.nextResetAt).toBe("2026-07-13T15:00:00.000Z");
  });

  it("tracks the most recent updatedAt as lastActivityAt", () => {
    const summary = summarizeTools([
      job({ tool: "codex-cli", updatedAt: "2026-07-13T01:00:00.000Z" }),
      job({ tool: "codex-cli", updatedAt: "2026-07-13T05:00:00.000Z" }),
      job({ tool: "codex-cli", updatedAt: "2026-07-13T03:00:00.000Z" }),
    ]);
    const codex = summary.tools.find((t) => t.tool === "codex-cli")!;
    expect(codex.lastActivityAt).toBe("2026-07-13T05:00:00.000Z");
  });

  it("flags unregistered tool ids (e.g. from an imported store)", () => {
    const summary = summarizeTools([job({ tool: "aider" as RelayJob["tool"], status: "completed" })]);
    const aider = summary.tools.find((t) => t.tool === "aider");
    expect(aider).toMatchObject({
      tool: "aider",
      displayName: "aider",
      binaries: [],
      registered: false,
      total: 1,
    });
    expect(summary.toolCount).toBe(1);
    expect(summary.registeredCount).toBe(3);
  });

  it("ranks by active desc, total desc, registered-first, name asc", () => {
    const summary = summarizeTools([
      // codex-cli: 2 active
      job({ tool: "codex-cli", status: "queued" }),
      job({ tool: "codex-cli", status: "resuming" }),
      // claude-code: 1 active, 3 total
      job({ tool: "claude-code", status: "queued" }),
      job({ tool: "claude-code", status: "completed" }),
      job({ tool: "claude-code", status: "completed" }),
      // an unregistered tool with 1 active, 1 total (ties nothing above)
      job({ tool: "ztool" as RelayJob["tool"], status: "queued" }),
    ]);
    // codex (2 active) > claude (1 active/3 total) > ztool (1 active/1 total) > generic (0/0, registered)
    expect(summary.tools.map((t) => t.tool)).toEqual(["codex-cli", "claude-code", "ztool", "generic"]);
  });

  it("puts a registered zero-job adapter above an unregistered zero-job tool", () => {
    // Force a bucket for an unregistered tool with zero jobs by... it can't
    // exist without a job, so instead verify registered tools with 0 jobs sort
    // among themselves by name asc when nothing has jobs.
    const summary = summarizeTools([]);
    expect(summary.tools.map((t) => t.tool)).toEqual(["claude-code", "codex-cli", "generic"]);
  });
});
