import { describe, expect, it } from "vitest";
import {
  computeDailyTrend,
  computeStats,
  computeWeekdayActivity,
  GROUP_DIMENSIONS,
  groupStats,
  isJobScopeActive,
  scopeJobs,
} from "./stats.js";
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

describe("isJobScopeActive", () => {
  it("is false for an empty scope or all-empty dimensions", () => {
    expect(isJobScopeActive({})).toBe(false);
    expect(isJobScopeActive({ statuses: [], tools: [], projects: [] })).toBe(false);
  });

  it("is true when any dimension has a value", () => {
    expect(isJobScopeActive({ statuses: ["completed"] })).toBe(true);
    expect(isJobScopeActive({ tools: ["codex-cli"] })).toBe(true);
    expect(isJobScopeActive({ projects: ["web"] })).toBe(true);
  });

  it("is true when a time boundary is set (including 0, a falsy epoch)", () => {
    expect(isJobScopeActive({ createdFrom: 0 })).toBe(true);
    expect(isJobScopeActive({ createdTo: 0 })).toBe(true);
    expect(isJobScopeActive({ createdFrom: 1_000 })).toBe(true);
  });
});

describe("scopeJobs", () => {
  it("returns a fresh copy (not the same array) when nothing filters", () => {
    const jobs = [job(), job()];
    const result = scopeJobs(jobs, {});
    expect(result).toEqual(jobs);
    expect(result).not.toBe(jobs);
  });

  it("filters by status", () => {
    const jobs = [job({ status: "completed" }), job({ status: "failed" }), job({ status: "queued" })];
    const result = scopeJobs(jobs, { statuses: ["completed", "failed"] });
    expect(result.map((j) => j.status)).toEqual(["completed", "failed"]);
  });

  it("filters by tool, matching unknown tool strings literally", () => {
    const jobs = [
      job({ tool: "claude-code" as AgentTool }),
      job({ tool: "codex-cli" as AgentTool }),
      job({ tool: "mystery" as AgentTool }),
    ];
    expect(scopeJobs(jobs, { tools: ["codex-cli"] }).map((j) => j.tool)).toEqual(["codex-cli"]);
    expect(scopeJobs(jobs, { tools: ["mystery"] }).map((j) => j.tool)).toEqual(["mystery"]);
  });

  it("filters by project (exact match)", () => {
    const jobs = [job({ project: "web" }), job({ project: "api" }), job({ project: "web-2" })];
    expect(scopeJobs(jobs, { projects: ["web"] }).map((j) => j.project)).toEqual(["web"]);
  });

  it("ANDs across dimensions and ORs within one", () => {
    const jobs = [
      job({ project: "web", status: "completed" }),
      job({ project: "web", status: "failed" }),
      job({ project: "api", status: "completed" }),
      job({ project: "web", status: "queued" }),
    ];
    const result = scopeJobs(jobs, { projects: ["web"], statuses: ["completed", "failed"] });
    expect(result).toHaveLength(2);
    expect(result.every((j) => j.project === "web")).toBe(true);
    expect(result.map((j) => j.status).sort()).toEqual(["completed", "failed"]);
  });

  it("feeds computeStats so metrics reflect only the scoped subset", () => {
    const jobs = [
      job({ project: "web", status: "completed" }),
      job({ project: "web", status: "failed" }),
      job({ project: "api", status: "completed" }),
    ];
    const stats = computeStats(scopeJobs(jobs, { projects: ["web"] }));
    expect(stats.total).toBe(2);
    expect(stats.successRate).toBe(0.5); // 1 of 2 resolved in "web"
  });

  it("filters by createdFrom (inclusive lower bound)", () => {
    const jobs = [
      job({ id: "old", createdAt: "2026-07-10T00:00:00.000Z" }),
      job({ id: "edge", createdAt: "2026-07-13T00:00:00.000Z" }),
      job({ id: "new", createdAt: "2026-07-15T00:00:00.000Z" }),
    ];
    const from = Date.parse("2026-07-13T00:00:00.000Z");
    expect(scopeJobs(jobs, { createdFrom: from }).map((j) => j.id)).toEqual(["edge", "new"]);
  });

  it("filters by createdTo (inclusive upper bound)", () => {
    const jobs = [
      job({ id: "old", createdAt: "2026-07-10T00:00:00.000Z" }),
      job({ id: "edge", createdAt: "2026-07-13T00:00:00.000Z" }),
      job({ id: "new", createdAt: "2026-07-15T00:00:00.000Z" }),
    ];
    const to = Date.parse("2026-07-13T00:00:00.000Z");
    expect(scopeJobs(jobs, { createdTo: to }).map((j) => j.id)).toEqual(["old", "edge"]);
  });

  it("keeps only jobs inside a [createdFrom, createdTo] window", () => {
    const jobs = [
      job({ id: "before", createdAt: "2026-07-09T00:00:00.000Z" }),
      job({ id: "inside", createdAt: "2026-07-12T00:00:00.000Z" }),
      job({ id: "after", createdAt: "2026-07-20T00:00:00.000Z" }),
    ];
    const scope = {
      createdFrom: Date.parse("2026-07-10T00:00:00.000Z"),
      createdTo: Date.parse("2026-07-15T00:00:00.000Z"),
    };
    expect(scopeJobs(jobs, scope).map((j) => j.id)).toEqual(["inside"]);
  });

  it("drops jobs with an unparseable createdAt when a time bound is active", () => {
    const jobs = [
      job({ id: "good", createdAt: "2026-07-14T00:00:00.000Z" }),
      job({ id: "bad", createdAt: "not-a-date" }),
    ];
    const from = Date.parse("2026-07-13T00:00:00.000Z");
    expect(scopeJobs(jobs, { createdFrom: from }).map((j) => j.id)).toEqual(["good"]);
    // ...but keeps it when no time bound is set.
    expect(scopeJobs(jobs, {}).map((j) => j.id)).toEqual(["good", "bad"]);
  });

  it("ANDs the time window with other dimensions", () => {
    const from = Date.parse("2026-07-13T00:00:00.000Z");
    const jobs = [
      job({ id: "a", project: "web", createdAt: "2026-07-14T00:00:00.000Z" }),
      job({ id: "b", project: "web", createdAt: "2026-07-10T00:00:00.000Z" }), // too old
      job({ id: "c", project: "api", createdAt: "2026-07-14T00:00:00.000Z" }), // wrong project
    ];
    expect(scopeJobs(jobs, { projects: ["web"], createdFrom: from }).map((j) => j.id)).toEqual(["a"]);
  });
});

describe("groupStats", () => {
  it("exposes every dimension it accepts", () => {
    expect(GROUP_DIMENSIONS).toEqual(["tool", "project", "status"]);
  });

  it("returns an empty array for no jobs", () => {
    expect(groupStats([], "project")).toEqual([]);
  });

  it("groups by project and computes full per-group stats", () => {
    const groups = groupStats(
      [
        job({ project: "web", status: "completed" }),
        job({ project: "web", status: "failed" }),
        job({ project: "api", status: "completed" }),
      ],
      "project"
    );
    expect(groups.map((g) => [g.key, g.count])).toEqual([
      ["web", 2],
      ["api", 1],
    ]);
    const web = groups.find((g) => g.key === "web");
    expect(web?.stats.total).toBe(2);
    expect(web?.stats.successRate).toBe(0.5); // 1 completed of 2 resolved
    const api = groups.find((g) => g.key === "api");
    expect(api?.stats.successRate).toBe(1);
  });

  it("groups by tool, keeping unknown tool strings as their own key", () => {
    const groups = groupStats(
      [
        job({ tool: "claude-code" as AgentTool }),
        job({ tool: "codex-cli" as AgentTool }),
        job({ tool: "mystery" as AgentTool }),
      ],
      "tool"
    );
    expect(groups.map((g) => g.key).sort()).toEqual(["claude-code", "codex-cli", "mystery"]);
  });

  it("groups by status", () => {
    const groups = groupStats(
      [job({ status: "queued" }), job({ status: "queued" }), job({ status: "completed" })],
      "status"
    );
    expect(groups.map((g) => [g.key, g.count])).toEqual([
      ["queued", 2],
      ["completed", 1],
    ]);
  });

  it("ranks groups by count desc, ties broken by key asc", () => {
    const groups = groupStats(
      [job({ project: "zeta" }), job({ project: "alpha" }), job({ project: "mid" }), job({ project: "mid" })],
      "project"
    );
    // mid (2) first; the two singletons tie on count and sort alpha < zeta.
    expect(groups.map((g) => g.key)).toEqual(["mid", "alpha", "zeta"]);
  });
});

describe("computeDailyTrend", () => {
  const now = Date.parse("2026-07-20T12:34:56.000Z");

  it("returns exactly `days` slots, oldest first, zero-filled", () => {
    const trend = computeDailyTrend([], { nowMs: now, days: 3 });
    expect(trend.map((d) => d.date)).toEqual(["2026-07-18", "2026-07-19", "2026-07-20"]);
    expect(trend.every((d) => d.count === 0)).toBe(true);
  });

  it("buckets jobs by their UTC creation day", () => {
    const jobs = [
      job({ createdAt: "2026-07-20T01:00:00.000Z" }),
      job({ createdAt: "2026-07-20T23:59:59.000Z" }),
      job({ createdAt: "2026-07-19T12:00:00.000Z" }),
    ];
    const trend = computeDailyTrend(jobs, { nowMs: now, days: 3 });
    expect(trend).toEqual([
      { date: "2026-07-18", count: 0 },
      { date: "2026-07-19", count: 1 },
      { date: "2026-07-20", count: 2 },
    ]);
  });

  it("excludes jobs outside the window (older than the oldest day or in the future)", () => {
    const jobs = [
      job({ createdAt: "2026-07-10T00:00:00.000Z" }), // too old for a 3-day window
      job({ createdAt: "2026-07-25T00:00:00.000Z" }), // future
      job({ createdAt: "2026-07-18T05:00:00.000Z" }), // in-window (oldest day)
    ];
    const trend = computeDailyTrend(jobs, { nowMs: now, days: 3 });
    expect(trend.reduce((sum, d) => sum + d.count, 0)).toBe(1);
    expect(trend[0]).toEqual({ date: "2026-07-18", count: 1 });
  });

  it("skips jobs with a missing/unparseable createdAt", () => {
    const jobs = [job({ createdAt: "not-a-date" }), job({ createdAt: "2026-07-20T00:00:00.000Z" })];
    const trend = computeDailyTrend(jobs, { nowMs: now, days: 2 });
    expect(trend.reduce((sum, d) => sum + d.count, 0)).toBe(1);
  });

  it("clamps days to at least 1 and floors fractional days", () => {
    expect(computeDailyTrend([], { nowMs: now, days: 0 }).map((d) => d.date)).toEqual(["2026-07-20"]);
    expect(computeDailyTrend([], { nowMs: now, days: -5 })).toHaveLength(1);
    expect(computeDailyTrend([], { nowMs: now, days: 2.9 })).toHaveLength(2);
  });
});

describe("computeWeekdayActivity", () => {
  it("returns exactly 7 Monday-first slots, zero-filled, for an empty list", () => {
    const week = computeWeekdayActivity([]);
    expect(week.map((w) => w.label)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(week.map((w) => w.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(week.every((w) => w.count === 0)).toBe(true);
  });

  it("buckets jobs by their UTC weekday (Monday-first)", () => {
    const jobs = [
      job({ createdAt: "2026-07-20T00:00:00.000Z" }), // Mon
      job({ createdAt: "2026-07-20T23:59:59.000Z" }), // Mon (same weekday, different time)
      job({ createdAt: "2026-07-21T12:00:00.000Z" }), // Tue
      job({ createdAt: "2026-07-26T06:00:00.000Z" }), // Sun
    ];
    const week = computeWeekdayActivity(jobs);
    expect(week[0]).toEqual({ weekday: 0, label: "Mon", count: 2 });
    expect(week[1]).toEqual({ weekday: 1, label: "Tue", count: 1 });
    expect(week[6]).toEqual({ weekday: 6, label: "Sun", count: 1 });
    expect(week.reduce((sum, w) => sum + w.count, 0)).toBe(4);
  });

  it("folds jobs from different calendar weeks onto the same weekday bucket", () => {
    const jobs = [
      job({ createdAt: "2026-07-20T00:00:00.000Z" }), // Mon
      job({ createdAt: "2026-07-13T00:00:00.000Z" }), // Mon, previous week
    ];
    const week = computeWeekdayActivity(jobs);
    expect(week[0].count).toBe(2);
  });

  it("skips jobs with a missing/unparseable createdAt", () => {
    const jobs = [job({ createdAt: "not-a-date" }), job({ createdAt: "2026-07-21T00:00:00.000Z" })];
    const week = computeWeekdayActivity(jobs);
    expect(week.reduce((sum, w) => sum + w.count, 0)).toBe(1);
    expect(week[1].count).toBe(1); // Tue
  });
});
