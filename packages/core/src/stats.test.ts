import { describe, expect, it } from "vitest";
import { computeStats } from "./stats.js";
import type { AgentTool, JobStatus, RelayJob } from "./types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "proj",
    tool: "claude-code" as AgentTool,
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "completed" as JobStatus,
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("computeStats", () => {
  it("returns an all-zero shape for an empty store", () => {
    const stats = computeStats([]);
    expect(stats.total).toBe(0);
    expect(stats.active).toBe(0);
    expect(stats.terminal).toBe(0);
    expect(stats.successRate).toBeNull();
    expect(stats.totalAttempts).toBe(0);
    expect(stats.retriedJobs).toBe(0);
    expect(stats.nextResetAt).toBeNull();
    expect(stats.projects).toEqual([]);
    // Every status and tool key is present and zero.
    expect(Object.values(stats.byStatus).every((n) => n === 0)).toBe(true);
    expect(stats.byTool).toEqual({ "claude-code": 0, "codex-cli": 0, generic: 0 });
  });

  it("splits active vs terminal counts", () => {
    const stats = computeStats([
      job({ status: "queued" }),
      job({ status: "waiting_for_reset", resetAt: "2026-07-13T01:00:00.000Z" }),
      job({ status: "resuming" }),
      job({ status: "completed" }),
      job({ status: "failed" }),
      job({ status: "cancelled" }),
    ]);
    expect(stats.total).toBe(6);
    expect(stats.active).toBe(3);
    expect(stats.terminal).toBe(3);
    expect(stats.byStatus.queued).toBe(1);
    expect(stats.byStatus.cancelled).toBe(1);
  });

  it("computes success rate as completed / (completed + failed), excluding cancelled", () => {
    const stats = computeStats([
      job({ status: "completed" }),
      job({ status: "completed" }),
      job({ status: "completed" }),
      job({ status: "failed" }),
      job({ status: "cancelled" }), // must not drag the rate down
    ]);
    // 3 completed / (3 completed + 1 failed) = 0.75
    expect(stats.successRate).toBeCloseTo(0.75, 10);
  });

  it("reports null success rate when nothing has resolved", () => {
    const stats = computeStats([job({ status: "queued" }), job({ status: "cancelled" })]);
    expect(stats.successRate).toBeNull();
  });

  it("sums attempts and counts retried jobs (attempts > 1)", () => {
    const stats = computeStats([
      job({ attempts: 1 }),
      job({ attempts: 3 }),
      job({ attempts: 5 }),
      job({ attempts: 0 }),
    ]);
    expect(stats.totalAttempts).toBe(9);
    expect(stats.retriedJobs).toBe(2);
  });

  it("tallies jobs per tool over the fixed tool set", () => {
    const stats = computeStats([
      job({ tool: "claude-code" }),
      job({ tool: "codex-cli" }),
      job({ tool: "codex-cli" }),
      job({ tool: "generic" }),
    ]);
    expect(stats.byTool).toEqual({ "claude-code": 1, "codex-cli": 2, generic: 1 });
  });

  it("ignores an unknown tool rather than inventing a key", () => {
    const stats = computeStats([job({ tool: "mystery-tool" as AgentTool })]);
    expect(stats.byTool).toEqual({ "claude-code": 0, "codex-cli": 0, generic: 0 });
    expect(stats.total).toBe(1); // still counted in the total
  });

  it("ranks projects by count desc, ties broken by name asc", () => {
    const stats = computeStats([
      job({ project: "web" }),
      job({ project: "web" }),
      job({ project: "api" }),
      job({ project: "api" }),
      job({ project: "cli" }),
    ]);
    expect(stats.projects).toEqual([
      { project: "api", count: 2 },
      { project: "web", count: 2 },
      { project: "cli", count: 1 },
    ]);
  });

  it("surfaces the earliest reset among waiting jobs", () => {
    const stats = computeStats([
      job({ status: "waiting_for_reset", resetAt: "2026-07-13T05:00:00.000Z" }),
      job({ status: "waiting_for_reset", resetAt: "2026-07-13T02:00:00.000Z" }),
      job({ status: "completed", resetAt: "2026-07-13T01:00:00.000Z" }), // not waiting -> ignored
    ]);
    expect(stats.nextResetAt).toBe("2026-07-13T02:00:00.000Z");
  });
});
