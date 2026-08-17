import { describe, expect, it } from "vitest";
import {
  computeActivityHeatmap,
  computeAttemptDistribution,
  computeDailyTrend,
  computeHourlyDistribution,
  computeStats,
  computeWeekdayDistribution,
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
      p95ResolutionMs: null,
      p99ResolutionMs: null,
      p25ResolutionMs: null,
      p75ResolutionMs: null,
      iqrResolutionMs: null,
      stdevResolutionMs: null,
      cvResolution: null,
      madResolutionMs: null,
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
    // p95 over sorted [1h,2h,6h]: rank=0.95*2=1.9 → 2h + 0.9*(6h-2h) = 2h+3.6h = 5.6h
    expect(stats.timing.p95ResolutionMs).toBe(Math.round(5.6 * 3_600_000));
    // p99 over sorted [1h,2h,6h]: rank=0.99*2=1.98 → 2h + 0.98*(6h-2h) = 2h+3.92h = 5.92h
    expect(stats.timing.p99ResolutionMs).toBe(Math.round(5.92 * 3_600_000));
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

  it("collapses median and every percentile to the single value for one resolved job", () => {
    const stats = computeStats([
      job({ status: "completed", createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T01:00:00.000Z" }),
    ]);
    expect(stats.timing.medianResolutionMs).toBe(3_600_000);
    expect(stats.timing.p90ResolutionMs).toBe(3_600_000);
    expect(stats.timing.p95ResolutionMs).toBe(3_600_000);
    expect(stats.timing.p99ResolutionMs).toBe(3_600_000);
    expect(stats.timing.minResolutionMs).toBe(3_600_000);
    expect(stats.timing.maxResolutionMs).toBe(3_600_000);
  });

  it("computes quartile spread (p25/p75/iqr) and stdev over resolved jobs", () => {
    const at = (h: number) => `2026-07-13T${String(h).padStart(2, "0")}:00:00.000Z`;
    const stats = computeStats([
      job({ status: "completed", createdAt: at(0), updatedAt: at(3) }), // 3h (out of order on purpose)
      job({ status: "failed", createdAt: at(0), updatedAt: at(1) }), // 1h
    ]);
    // sorted spans [1h, 3h]
    // p25: rank=0.25 → 1h + 0.25*(3h-1h) = 1.5h; p75: 1h + 0.75*2h = 2.5h
    expect(stats.timing.p25ResolutionMs).toBe(Math.round(1.5 * 3_600_000));
    expect(stats.timing.p75ResolutionMs).toBe(Math.round(2.5 * 3_600_000));
    // iqr = p75 - p25 = 1h
    expect(stats.timing.iqrResolutionMs).toBe(3_600_000);
    // mean 2h; population variance = ((1-2)^2 + (3-2)^2)/2 = 1 h^2 → stdev 1h
    expect(stats.timing.stdevResolutionMs).toBe(3_600_000);
    // cv = stdev / mean = 1h / 2h = 0.5 (scale-free ratio)
    expect(stats.timing.cvResolution).toBe(0.5);
    // median 2h; deviations |1h-2h|,|3h-2h| = [1h,1h]; median of those = 1h
    expect(stats.timing.madResolutionMs).toBe(3_600_000);
  });

  it("reports an outlier-robust MAD below the outlier-sensitive stdev", () => {
    const at = (h: number) => `2026-07-13T${String(h).padStart(2, "0")}:00:00.000Z`;
    // Four tight 1h resolutions plus one 20h outlier: MAD ignores the outlier,
    // stdev is dragged upward by it.
    const stats = computeStats([
      job({ status: "completed", createdAt: at(0), updatedAt: at(1) }), // 1h
      job({ status: "completed", createdAt: at(0), updatedAt: at(1) }), // 1h
      job({ status: "completed", createdAt: at(0), updatedAt: at(1) }), // 1h
      job({ status: "completed", createdAt: at(0), updatedAt: at(1) }), // 1h
      job({ status: "completed", createdAt: at(0), updatedAt: at(20) }), // 20h outlier
    ]);
    // sorted spans [1h,1h,1h,1h,20h]; median = 1h.
    // deviations = [0,0,0,0,19h]; median deviation = 0 → MAD unmoved by the outlier.
    expect(stats.timing.madResolutionMs).toBe(0);
    // stdev, in contrast, is inflated well past an hour by the 20h span.
    expect(stats.timing.stdevResolutionMs).toBeGreaterThan(3_600_000);
  });

  it("collapses spread metrics to zero for a single resolved job", () => {
    const stats = computeStats([
      job({ status: "completed", createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T01:00:00.000Z" }),
    ]);
    expect(stats.timing.p25ResolutionMs).toBe(3_600_000);
    expect(stats.timing.p75ResolutionMs).toBe(3_600_000);
    expect(stats.timing.iqrResolutionMs).toBe(0);
    expect(stats.timing.stdevResolutionMs).toBe(0);
    // single span: stdev 0, nonzero mean → cv 0 (no spread, well-defined)
    expect(stats.timing.cvResolution).toBe(0);
    // single span: deviation from its own median is 0 → MAD 0
    expect(stats.timing.madResolutionMs).toBe(0);
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
      p95ResolutionMs: null,
      p99ResolutionMs: null,
      p25ResolutionMs: null,
      p75ResolutionMs: null,
      iqrResolutionMs: null,
      stdevResolutionMs: null,
      cvResolution: null,
      madResolutionMs: null,
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

describe("computeHourlyDistribution", () => {
  it("returns exactly 24 slots, hour 0 through 23, zero-filled for an empty store", () => {
    const dist = computeHourlyDistribution([]);
    expect(dist).toHaveLength(24);
    expect(dist.map((h) => h.hour)).toEqual([...Array(24).keys()]);
    expect(dist.every((h) => h.count === 0)).toBe(true);
  });

  it("buckets jobs by their UTC creation hour, across all days", () => {
    const jobs = [
      job({ createdAt: "2026-07-20T09:15:00.000Z" }),
      job({ createdAt: "2026-07-18T09:59:59.000Z" }), // different day, same hour
      job({ createdAt: "2026-07-20T23:00:00.000Z" }),
    ];
    const dist = computeHourlyDistribution(jobs);
    expect(dist[9].count).toBe(2);
    expect(dist[23].count).toBe(1);
    expect(dist.reduce((sum, h) => sum + h.count, 0)).toBe(3);
  });

  it("places boundary hours correctly (00:00 and 23:59 UTC)", () => {
    const jobs = [job({ createdAt: "2026-07-20T00:00:00.000Z" }), job({ createdAt: "2026-07-20T23:59:59.999Z" })];
    const dist = computeHourlyDistribution(jobs);
    expect(dist[0].count).toBe(1);
    expect(dist[23].count).toBe(1);
  });

  it("skips jobs with a missing/unparseable createdAt", () => {
    const jobs = [job({ createdAt: "not-a-date" }), job({ createdAt: "2026-07-20T14:00:00.000Z" })];
    const dist = computeHourlyDistribution(jobs);
    expect(dist.reduce((sum, h) => sum + h.count, 0)).toBe(1);
    expect(dist[14].count).toBe(1);
  });

  it("does not mutate its input", () => {
    const jobs = [job({ createdAt: "2026-07-20T05:00:00.000Z" })];
    const before = JSON.stringify(jobs);
    computeHourlyDistribution(jobs);
    expect(JSON.stringify(jobs)).toBe(before);
  });

  it("shifts buckets by a positive offset (local wall clock, e.g. UTC+09:00)", () => {
    // 23:00 UTC + 9h = 08:00 next day, local; 20:00 UTC + 9h = 05:00 local.
    const jobs = [job({ createdAt: "2026-07-20T23:00:00.000Z" }), job({ createdAt: "2026-07-20T20:00:00.000Z" })];
    const dist = computeHourlyDistribution(jobs, 540);
    expect(dist[8].count).toBe(1);
    expect(dist[5].count).toBe(1);
    expect(dist[23].count).toBe(0); // no longer UTC-bucketed
  });

  it("shifts buckets by a negative offset and wraps across midnight (e.g. UTC-05:00)", () => {
    // 02:00 UTC − 5h = 21:00 the previous day, local.
    const jobs = [job({ createdAt: "2026-07-20T02:00:00.000Z" })];
    const dist = computeHourlyDistribution(jobs, -300);
    expect(dist[21].count).toBe(1);
    expect(dist[2].count).toBe(0);
  });

  it("offset 0 matches the default UTC bucketing", () => {
    const jobs = [job({ createdAt: "2026-07-20T09:15:00.000Z" })];
    expect(computeHourlyDistribution(jobs, 0)).toEqual(computeHourlyDistribution(jobs));
  });
});

describe("computeWeekdayDistribution", () => {
  it("returns exactly 7 slots, Sun through Sat, zero-filled for an empty store", () => {
    const dist = computeWeekdayDistribution([]);
    expect(dist).toHaveLength(7);
    expect(dist.map((w) => w.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(dist.map((w) => w.name)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    expect(dist.every((w) => w.count === 0)).toBe(true);
  });

  it("buckets jobs by their UTC creation weekday, across all weeks", () => {
    // 2026-07-20 is a Monday, 2026-07-27 is the next Monday, 2026-07-22 a Wednesday.
    const jobs = [
      job({ createdAt: "2026-07-20T09:15:00.000Z" }), // Mon
      job({ createdAt: "2026-07-27T23:00:00.000Z" }), // Mon, following week
      job({ createdAt: "2026-07-22T12:00:00.000Z" }), // Wed
    ];
    const dist = computeWeekdayDistribution(jobs);
    expect(dist[1].count).toBe(2); // Monday
    expect(dist[3].count).toBe(1); // Wednesday
    expect(dist.reduce((sum, w) => sum + w.count, 0)).toBe(3);
  });

  it("places Sunday (weekday 0) and Saturday (weekday 6) correctly", () => {
    // 2026-07-19 is a Sunday, 2026-07-25 is a Saturday.
    const jobs = [job({ createdAt: "2026-07-19T00:00:00.000Z" }), job({ createdAt: "2026-07-25T23:59:59.999Z" })];
    const dist = computeWeekdayDistribution(jobs);
    expect(dist[0].count).toBe(1); // Sunday
    expect(dist[6].count).toBe(1); // Saturday
  });

  it("skips jobs with a missing/unparseable createdAt", () => {
    const jobs = [job({ createdAt: "not-a-date" }), job({ createdAt: "2026-07-22T14:00:00.000Z" })]; // Wed
    const dist = computeWeekdayDistribution(jobs);
    expect(dist.reduce((sum, w) => sum + w.count, 0)).toBe(1);
    expect(dist[3].count).toBe(1);
  });

  it("does not mutate its input", () => {
    const jobs = [job({ createdAt: "2026-07-20T05:00:00.000Z" })];
    const before = JSON.stringify(jobs);
    computeWeekdayDistribution(jobs);
    expect(JSON.stringify(jobs)).toBe(before);
  });

  it("a positive offset can roll a job onto the next local day", () => {
    // 2026-07-19T23:00Z is a Sunday; +9h → Mon 08:00 local.
    const jobs = [job({ createdAt: "2026-07-19T23:00:00.000Z" })];
    const dist = computeWeekdayDistribution(jobs, 540);
    expect(dist[1].count).toBe(1); // Monday, local
    expect(dist[0].count).toBe(0); // no longer Sunday (UTC)
  });

  it("a negative offset can roll a job onto the previous local day", () => {
    // 2026-07-20T02:00Z is a Monday; −5h → Sun 21:00 local.
    const jobs = [job({ createdAt: "2026-07-20T02:00:00.000Z" })];
    const dist = computeWeekdayDistribution(jobs, -300);
    expect(dist[0].count).toBe(1); // Sunday, local
    expect(dist[1].count).toBe(0);
  });
});

describe("computeActivityHeatmap", () => {
  it("returns a fully-allocated 7×24 grid, zero-filled for an empty store", () => {
    const heat = computeActivityHeatmap([]);
    expect(heat.cells).toHaveLength(7);
    expect(heat.cells.every((row) => row.length === 24)).toBe(true);
    expect(heat.cells.every((row) => row.every((c) => c === 0))).toBe(true);
    expect(heat.total).toBe(0);
    expect(heat.maxCell).toBe(0);
  });

  it("buckets jobs into the [weekday][hour] cell of their UTC createdAt", () => {
    // 2026-07-20 is a Monday (weekday 1), 2026-07-22 a Wednesday (weekday 3).
    const jobs = [
      job({ createdAt: "2026-07-20T09:15:00.000Z" }), // Mon 09
      job({ createdAt: "2026-07-27T09:59:59.000Z" }), // Mon 09, following week
      job({ createdAt: "2026-07-22T23:00:00.000Z" }), // Wed 23
    ];
    const heat = computeActivityHeatmap(jobs);
    expect(heat.cells[1][9]).toBe(2); // Monday 09:00
    expect(heat.cells[3][23]).toBe(1); // Wednesday 23:00
    expect(heat.total).toBe(3);
    expect(heat.maxCell).toBe(2);
  });

  it("places both axis corners correctly (Sun 00 and Sat 23)", () => {
    // 2026-07-19 is a Sunday, 2026-07-25 is a Saturday.
    const jobs = [job({ createdAt: "2026-07-19T00:00:00.000Z" }), job({ createdAt: "2026-07-25T23:59:59.999Z" })];
    const heat = computeActivityHeatmap(jobs);
    expect(heat.cells[0][0]).toBe(1); // Sunday 00:00
    expect(heat.cells[6][23]).toBe(1); // Saturday 23:00
    expect(heat.maxCell).toBe(1);
  });

  it("skips jobs with a missing/unparseable createdAt", () => {
    const jobs = [job({ createdAt: "not-a-date" }), job({ createdAt: "2026-07-22T14:00:00.000Z" })]; // Wed 14
    const heat = computeActivityHeatmap(jobs);
    expect(heat.total).toBe(1);
    expect(heat.cells[3][14]).toBe(1);
  });

  it("does not mutate its input", () => {
    const jobs = [job({ createdAt: "2026-07-20T05:00:00.000Z" })];
    const before = JSON.stringify(jobs);
    computeActivityHeatmap(jobs);
    expect(JSON.stringify(jobs)).toBe(before);
  });

  it("shifts cells by a positive offset, rolling across midnight onto the next local day", () => {
    // 2026-07-19T23:00Z is a Sunday 23:00; +9h (UTC+09:00) → Mon 08:00 local.
    const jobs = [job({ createdAt: "2026-07-19T23:00:00.000Z" })];
    const heat = computeActivityHeatmap(jobs, 540);
    expect(heat.cells[1][8]).toBe(1); // Monday 08:00, local
    expect(heat.cells[0][23]).toBe(0); // no longer Sunday 23:00 (UTC)
  });

  it("offset 0 matches the default UTC bucketing", () => {
    const jobs = [job({ createdAt: "2026-07-20T09:15:00.000Z" })];
    expect(computeActivityHeatmap(jobs, 0)).toEqual(computeActivityHeatmap(jobs));
  });
});

describe("computeAttemptDistribution", () => {
  it("returns a single zero bucket for an empty store", () => {
    const dist = computeAttemptDistribution([]);
    expect(dist.buckets).toEqual([{ attempts: 0, count: 0 }]);
    expect(dist.total).toBe(0);
    expect(dist.maxAttempts).toBe(0);
    expect(dist.totalAttempts).toBe(0);
  });

  it("buckets jobs by their attempt counter, contiguous and zero-filled", () => {
    const jobs = [job({ attempts: 0 }), job({ attempts: 1 }), job({ attempts: 1 }), job({ attempts: 3 })];
    const dist = computeAttemptDistribution(jobs);
    expect(dist.buckets).toEqual([
      { attempts: 0, count: 1 },
      { attempts: 1, count: 2 },
      { attempts: 2, count: 0 }, // gap is preserved, zero-filled
      { attempts: 3, count: 1 },
    ]);
    expect(dist.total).toBe(4);
    expect(dist.maxAttempts).toBe(3);
    expect(dist.totalAttempts).toBe(0 + 1 + 1 + 3);
  });

  it("totalAttempts matches computeStats.totalAttempts", () => {
    const jobs = [job({ attempts: 2 }), job({ attempts: 5 }), job({ attempts: 1 })];
    expect(computeAttemptDistribution(jobs).totalAttempts).toBe(computeStats(jobs).totalAttempts);
  });

  it("defensively coerces a corrupt attempt counter to a non-negative integer", () => {
    const jobs = [job({ attempts: -3 }), job({ attempts: 2.7 }), job({ attempts: Number.NaN })];
    const dist = computeAttemptDistribution(jobs);
    // -3 → 0, 2.7 → 2 (floor), NaN → 0. So bucket 0 has 2 jobs, bucket 2 has 1.
    expect(dist.buckets).toEqual([
      { attempts: 0, count: 2 },
      { attempts: 1, count: 0 },
      { attempts: 2, count: 1 },
    ]);
    expect(dist.totalAttempts).toBe(2); // 0 + 2 + 0
    expect(dist.total).toBe(3);
  });

  it("does not mutate its input", () => {
    const jobs = [job({ attempts: 4 })];
    const before = JSON.stringify(jobs);
    computeAttemptDistribution(jobs);
    expect(JSON.stringify(jobs)).toBe(before);
  });
});
