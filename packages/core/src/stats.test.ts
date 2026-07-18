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
    expect(stats.timing).toEqual({
      resolvedCount: 0,
      avgResolutionMs: null,
      minResolutionMs: null,
      maxResolutionMs: null,
      medianResolutionMs: null,
      p90ResolutionMs: null,
    });
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

  it("computes resolution timing over completed + failed jobs", () => {
    const stats = computeStats([
      // completed: 1h lifecycle
      job({
        status: "completed",
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T01:00:00.000Z",
      }),
      // failed: 3h lifecycle
      job({
        status: "failed",
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T03:00:00.000Z",
      }),
    ]);
    expect(stats.timing.resolvedCount).toBe(2);
    expect(stats.timing.minResolutionMs).toBe(3_600_000);
    expect(stats.timing.maxResolutionMs).toBe(10_800_000);
    expect(stats.timing.avgResolutionMs).toBe(7_200_000); // (1h + 3h) / 2 = 2h
  });

  it("reports median and p90 over an odd number of resolved jobs", () => {
    // spans of 1h, 2h, 6h (created at 0, updated at 1h/2h/6h)
    const at = (h: number) => `2026-07-13T${String(h).padStart(2, "0")}:00:00.000Z`;
    const stats = computeStats([
      job({ status: "completed", createdAt: at(0), updatedAt: at(2) }), // 2h
      job({ status: "completed", createdAt: at(0), updatedAt: at(1) }), // 1h  (out of order on purpose)
      job({ status: "failed", createdAt: at(0), updatedAt: at(6) }), // 6h
    ]);
    expect(stats.timing.resolvedCount).toBe(3);
    // median of {1h,2h,6h} is the middle value → 2h
    expect(stats.timing.medianResolutionMs).toBe(2 * 3_600_000);
    // avg = (1+2+6)/3 h = 3h
    expect(stats.timing.avgResolutionMs).toBe(3 * 3_600_000);
    // p90 over sorted [1h,2h,6h]: rank=0.9*2=1.8 → 2h + 0.8*(6h-2h) = 2h+3.2h = 5.2h
    expect(stats.timing.p90ResolutionMs).toBe(Math.round(5.2 * 3_600_000));
  });

  it("interpolates the median over an even number of resolved jobs", () => {
    const at = (h: number) => `2026-07-13T${String(h).padStart(2, "0")}:00:00.000Z`;
    const stats = computeStats([
      job({ status: "completed", createdAt: at(0), updatedAt: at(2) }), // 2h
      job({ status: "completed", createdAt: at(0), updatedAt: at(4) }), // 4h
    ]);
    // median of {2h,4h} interpolates to the midpoint → 3h
    expect(stats.timing.medianResolutionMs).toBe(3 * 3_600_000);
  });

  it("collapses median and p90 to the single value for one resolved job", () => {
    const stats = computeStats([
      job({ status: "completed", createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T01:00:00.000Z" }),
    ]);
    expect(stats.timing.medianResolutionMs).toBe(3_600_000);
    expect(stats.timing.p90ResolutionMs).toBe(3_600_000);
    expect(stats.timing.minResolutionMs).toBe(3_600_000);
    expect(stats.timing.maxResolutionMs).toBe(3_600_000);
  });

  it("excludes cancelled and still-active jobs from resolution timing", () => {
    const stats = computeStats([
      job({
        status: "cancelled", // user cut, not a relay resolution
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T09:00:00.000Z",
      }),
      job({
        status: "waiting_for_reset", // not terminal
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T08:00:00.000Z",
      }),
      job({
        status: "completed",
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:30:00.000Z",
      }),
    ]);
    expect(stats.timing.resolvedCount).toBe(1);
    expect(stats.timing.avgResolutionMs).toBe(1_800_000); // only the 30m completed job
  });

  it("skips resolved jobs with unparseable or negative spans", () => {
    const stats = computeStats([
      job({ status: "completed", createdAt: "not-a-date", updatedAt: "2026-07-13T01:00:00.000Z" }),
      // negative span (clock skew): updatedAt before createdAt
      job({
        status: "failed",
        createdAt: "2026-07-13T05:00:00.000Z",
        updatedAt: "2026-07-13T04:00:00.000Z",
      }),
      job({
        status: "completed",
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T02:00:00.000Z",
      }),
    ]);
    expect(stats.timing.resolvedCount).toBe(1);
    expect(stats.timing.avgResolutionMs).toBe(7_200_000); // only the valid 2h job
  });

  it("reports empty timing when no jobs have resolved", () => {
    const stats = computeStats([job({ status: "queued" }), job({ status: "resuming" })]);
    expect(stats.timing).toEqual({
      resolvedCount: 0,
      avgResolutionMs: null,
      minResolutionMs: null,
      maxResolutionMs: null,
      medianResolutionMs: null,
      p90ResolutionMs: null,
    });
  });
});
