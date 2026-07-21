import type { DailyActivity, HourlyActivity, RelayJob } from "@agentrelay/core";
import { computeDailyTrend, computeHourlyTrend, computeStats, groupStats } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  formatDurationMs,
  formatSuccessRate,
  NO_GROUP_MESSAGE,
  NO_SCOPE_MATCH_MESSAGE,
  NO_STATS_MESSAGE,
  renderGroupedStats,
  renderGroupedStatsJson,
  renderHourly,
  renderStats,
  renderStatsJson,
  renderTrend,
} from "../src/stats.js";

const NOW = Date.parse("2026-07-13T00:00:00.000Z");

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

describe("formatSuccessRate", () => {
  it("renders a percentage, rounding to whole numbers", () => {
    expect(formatSuccessRate(0.75)).toBe("75%");
    expect(formatSuccessRate(1)).toBe("100%");
    expect(formatSuccessRate(0)).toBe("0%");
  });

  it("renders n/a for a null rate", () => {
    expect(formatSuccessRate(null)).toBe("n/a");
  });
});

describe("formatDurationMs", () => {
  it("renders sub-second and second spans", () => {
    expect(formatDurationMs(0)).toBe("<1s");
    expect(formatDurationMs(500)).toBe("<1s");
    expect(formatDurationMs(8_000)).toBe("8s");
  });

  it("renders minutes with seconds, hours with minutes, days with hours", () => {
    expect(formatDurationMs(90_000)).toBe("1m 30s");
    expect(formatDurationMs(3_600_000)).toBe("1h 0m");
    expect(formatDurationMs(4 * 3_600_000 + 12 * 60_000)).toBe("4h 12m");
    expect(formatDurationMs(26 * 3_600_000)).toBe("1d 2h");
  });

  it("returns - for negative or non-finite input", () => {
    expect(formatDurationMs(-1)).toBe("-");
    expect(formatDurationMs(Number.NaN)).toBe("-");
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe("-");
  });
});

describe("renderStats", () => {
  it("shows the onboarding message for an empty store", () => {
    expect(renderStats(computeStats([]))).toBe(NO_STATS_MESSAGE);
  });

  it("summarizes totals, success rate, retries and breakdowns", () => {
    const stats = computeStats([
      job({ status: "completed", tool: "claude-code", project: "web", attempts: 2 }),
      job({ status: "completed", tool: "claude-code", project: "web", attempts: 1 }),
      job({ status: "completed", tool: "codex-cli", project: "api", attempts: 3 }),
      job({ status: "failed", tool: "generic", project: "api", attempts: 5 }),
      job({ status: "cancelled", tool: "claude-code", project: "cli", attempts: 1 }),
      job({
        status: "waiting_for_reset",
        tool: "claude-code",
        project: "web",
        resetAt: new Date(NOW + 90 * 60_000).toISOString(),
      }),
    ]);
    const out = renderStats(stats, { now: NOW });

    expect(out).toContain("6 job(s) tracked");
    expect(out).toContain("active: 1");
    expect(out).toContain("terminal: 5");
    // 3 completed / (3 completed + 1 failed) = 75%
    expect(out).toContain("success rate: 75%");
    // total attempts = 2+1+3+5+1+1 = 13; retried (attempts>1) = 3
    expect(out).toContain("total attempts: 13");
    expect(out).toContain("retried jobs: 3");
    expect(out).toContain("next reset in: 1h 30m");
    // per-tool + per-project breakdowns
    expect(out).toContain("claude-code:4");
    expect(out).toContain("codex-cli:1");
    expect(out).toMatch(/web\s+3/);
    expect(out).toMatch(/api\s+2/);
  });

  it("renders a resolution-time block when jobs have resolved", () => {
    const stats = computeStats([
      job({ status: "completed", createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T01:00:00.000Z" }),
      job({ status: "failed", createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T03:00:00.000Z" }),
    ]);
    const out = renderStats(stats, { now: NOW });
    expect(out).toContain("resolution time");
    expect(out).toContain("avg 2h 0m");
    expect(out).toContain("min 1h 0m");
    expect(out).toContain("max 3h 0m");
    expect(out).toContain("over 2 job(s)");
    // median of {1h,3h} = 2h; p90 interpolates to 2h48m over the sorted pair.
    expect(out).toContain("median 2h 0m");
    expect(out).toContain("p90 2h 48m");
  });

  it("omits the resolution-time block when nothing has resolved", () => {
    const stats = computeStats([job({ status: "queued" }), job({ status: "waiting_for_reset" })]);
    const out = renderStats(stats, { now: NOW });
    expect(out).not.toContain("resolution time");
  });

  it("caps the project list at five entries", () => {
    const jobs: RelayJob[] = [];
    for (const p of ["a", "b", "c", "d", "e", "f", "g"]) jobs.push(job({ project: p }));
    const out = renderStats(computeStats(jobs), { now: NOW });
    // 7 distinct projects but only the top 5 are printed.
    const projectLines = out.split("\n").filter((l) => /^ {2}[a-g] {24}1$/.test(l));
    expect(projectLines.length).toBe(5);
  });
});

describe("renderStatsJson", () => {
  it("emits a stable machine-readable shape", () => {
    const stats = computeStats([job({ status: "completed" }), job({ status: "failed" })]);
    const parsed = JSON.parse(renderStatsJson(stats, "/tmp/store.json", { generatedAt: "2026-07-13T00:00:00.000Z" }));
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-13T00:00:00.000Z");
    expect(parsed.stats.total).toBe(2);
    expect(parsed.stats.successRate).toBeCloseTo(0.5, 10);
    // timing block is carried through untouched for scripts/jq.
    expect(parsed.stats.timing.resolvedCount).toBe(2);
    expect(typeof parsed.stats.timing.avgResolutionMs).toBe("number");
  });

  it("omits scope when inactive and echoes it back when set", () => {
    const stats = computeStats([job()]);
    const plain = JSON.parse(renderStatsJson(stats, "/tmp/store.json", { generatedAt: "2026-07-13T00:00:00.000Z" }));
    expect(plain.scope).toBeUndefined();

    const scoped = JSON.parse(
      renderStatsJson(stats, "/tmp/store.json", {
        generatedAt: "2026-07-13T00:00:00.000Z",
        scope: { projects: ["demo"] },
      })
    );
    expect(scoped.scope).toEqual({ projects: ["demo"] });
  });
});

describe("renderStats with a scope", () => {
  it("prepends a scope note when one is given", () => {
    const stats = computeStats([job()]);
    const out = renderStats(stats, { now: NOW, scopeNote: "project=demo" });
    expect(out).toContain("scope: project=demo");
    expect(out).toContain("1 job(s) tracked");
  });

  it("says no-match (not the onboarding hint) for an empty scoped subset", () => {
    const empty = computeStats([]);
    expect(renderStats(empty, { scopeNote: "project=nope" })).toBe(NO_SCOPE_MATCH_MESSAGE);
    // Without a scope, an empty store still shows the onboarding hint.
    expect(renderStats(empty)).toBe(NO_STATS_MESSAGE);
  });
});

describe("renderGroupedStats", () => {
  it("says no-group for an empty store, no-match for an empty scoped subset", () => {
    expect(renderGroupedStats([], "project")).toBe(NO_GROUP_MESSAGE);
    expect(renderGroupedStats([], "project", { scopeNote: "tool=codex-cli" })).toContain(NO_SCOPE_MATCH_MESSAGE);
  });

  it("renders one row per group with count, success rate and median resolve", () => {
    const jobs = [
      job({
        project: "web",
        status: "completed",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T01:00:00.000Z",
      }),
      job({
        project: "web",
        status: "failed",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T03:00:00.000Z",
      }),
      // A still-active job never resolves, so its group has no median span → "-".
      job({ project: "api", status: "queued" }),
    ];
    const out = renderGroupedStats(groupStats(jobs, "project"), "project");
    expect(out).toContain("3 job(s) across 2 project(s)");
    expect(out).toContain("web");
    expect(out).toContain("api");
    // web: 1 completed of 2 resolved = 50%, median of {1h,3h} = 2h
    expect(out).toMatch(/web\s+2\s+50%\s+2h 0m/);
    // api: still queued → success rate n/a, no resolved span → "-"
    expect(out).toMatch(/api\s+1\s+n\/a\s+-/);
  });

  it("prepends a scope note when given", () => {
    const out = renderGroupedStats(groupStats([job()], "tool"), "tool", { scopeNote: "status=completed" });
    expect(out).toContain("scope: status=completed");
  });
});

describe("renderGroupedStatsJson", () => {
  it("echoes the dimension and groups, plus an active scope", () => {
    const groups = groupStats([job({ tool: "claude-code" }), job({ tool: "codex-cli" })], "tool");
    const parsed = JSON.parse(
      renderGroupedStatsJson(groups, "tool", "/tmp/store.json", {
        generatedAt: "2026-07-13T00:00:00.000Z",
        scope: { statuses: ["completed"] },
      })
    );
    expect(parsed.groupBy).toBe("tool");
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.scope).toEqual({ statuses: ["completed"] });
    expect(parsed.groups.map((g: { key: string }) => g.key).sort()).toEqual(["claude-code", "codex-cli"]);
  });

  it("omits an inactive (empty) scope", () => {
    const parsed = JSON.parse(
      renderGroupedStatsJson(groupStats([job()], "status"), "status", "/tmp/s.json", {
        generatedAt: "2026-07-13T00:00:00.000Z",
        scope: {},
      })
    );
    expect(parsed.scope).toBeUndefined();
  });
});

describe("renderTrend", () => {
  const trend: DailyActivity[] = [
    { date: "2026-07-18", count: 0 },
    { date: "2026-07-19", count: 2 },
    { date: "2026-07-20", count: 4 },
  ];

  it("renders a header, one row per day, and a footer total", () => {
    const out = renderTrend(trend);
    const lines = out.split("\n");
    expect(lines[0]).toContain("activity");
    expect(out).toContain("2026-07-18");
    expect(out).toContain("2026-07-19");
    expect(out).toContain("2026-07-20");
    // Each day's count appears at the end of its row.
    expect(out).toMatch(/2026-07-20 .* 4/);
    expect(lines[lines.length - 1]).toContain("6 job(s) over 3 day(s)");
  });

  it("scales bars to the busiest day and draws blocks only for non-zero days", () => {
    const out = renderTrend(trend);
    const rows = out.split("\n");
    const zeroRow = rows.find((r) => r.includes("2026-07-18")) ?? "";
    const peakRow = rows.find((r) => r.includes("2026-07-20")) ?? "";
    // Busiest day gets the widest bar; a zero day has no block char.
    expect(peakRow).toContain("█");
    expect(zeroRow).not.toContain("█");
    // The peak bar is at least as wide as the 2-count day's bar.
    const width = (r: string) => (r.match(/█/g) ?? []).length;
    const midRow = rows.find((r) => r.includes("2026-07-19")) ?? "";
    expect(width(peakRow)).toBeGreaterThanOrEqual(width(midRow));
    expect(width(midRow)).toBeGreaterThanOrEqual(1);
  });

  it("handles an all-zero window without any bars", () => {
    const out = renderTrend([
      { date: "2026-07-19", count: 0 },
      { date: "2026-07-20", count: 0 },
    ]);
    expect(out).not.toContain("█");
    expect(out).toContain("0 job(s) over 2 day(s)");
  });

  it("round-trips a store subset through computeDailyTrend + renderTrend", () => {
    const now = Date.parse("2026-07-20T10:00:00.000Z");
    const jobs = [
      job({ createdAt: "2026-07-20T01:00:00.000Z" }),
      job({ createdAt: "2026-07-20T09:00:00.000Z" }),
      job({ createdAt: "2026-07-19T09:00:00.000Z" }),
    ];
    const computed = computeDailyTrend(jobs, { nowMs: now, days: 2 });
    expect(computed).toEqual([
      { date: "2026-07-19", count: 1 },
      { date: "2026-07-20", count: 2 },
    ]);
    expect(renderTrend(computed)).toContain("3 job(s) over 2 day(s)");
  });
});

describe("renderStatsJson trend field", () => {
  it("omits `trend` by default but includes it when provided", () => {
    const stats = computeStats([job()]);
    const withoutTrend = JSON.parse(renderStatsJson(stats, "/tmp/s.json", { generatedAt: "x" }));
    expect("trend" in withoutTrend).toBe(false);
    const trend: DailyActivity[] = [{ date: "2026-07-20", count: 1 }];
    const withTrend = JSON.parse(renderStatsJson(stats, "/tmp/s.json", { generatedAt: "x", trend }));
    expect(withTrend.trend).toEqual(trend);
  });
});

describe("renderHourly", () => {
  // A 24-slot histogram with one spike at 09h and a smaller bump at 14h.
  const hourly: HourlyActivity[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    count: hour === 9 ? 4 : hour === 14 ? 2 : 0,
  }));

  it("renders a header, 24 rows with zero-padded hour labels, and a footer total", () => {
    const out = renderHourly(hourly);
    const lines = out.split("\n");
    expect(lines[0]).toContain("activity");
    expect(lines[0]).toContain("per hour of day");
    // Header + 24 rows + footer.
    expect(lines).toHaveLength(26);
    expect(out).toContain("00h");
    expect(out).toContain("09h");
    expect(out).toContain("23h");
    // The busiest hour's count appears at the end of its row.
    expect(out).toMatch(/09h .* 4/);
    expect(lines[lines.length - 1]).toContain("6 job(s) across 24 hour(s)");
  });

  it("scales bars to the busiest hour and draws blocks only for non-zero hours", () => {
    const out = renderHourly(hourly);
    const rows = out.split("\n");
    const zeroRow = rows.find((r) => r.startsWith("  00h")) ?? "";
    const peakRow = rows.find((r) => r.startsWith("  09h")) ?? "";
    const midRow = rows.find((r) => r.startsWith("  14h")) ?? "";
    expect(peakRow).toContain("█");
    expect(zeroRow).not.toContain("█");
    const width = (r: string) => (r.match(/█/g) ?? []).length;
    expect(width(peakRow)).toBeGreaterThanOrEqual(width(midRow));
    expect(width(midRow)).toBeGreaterThanOrEqual(1);
  });

  it("handles an all-zero day without any bars", () => {
    const out = renderHourly(Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })));
    expect(out).not.toContain("█");
    expect(out).toContain("0 job(s) across 24 hour(s)");
  });

  it("round-trips a store subset through computeHourlyTrend + renderHourly", () => {
    const jobs = [
      job({ createdAt: "2026-07-20T09:00:00.000Z" }),
      job({ createdAt: "2026-07-19T09:30:00.000Z" }),
      job({ createdAt: "2026-07-18T14:00:00.000Z" }),
    ];
    const computed = computeHourlyTrend(jobs);
    expect(computed[9].count).toBe(2);
    expect(computed[14].count).toBe(1);
    expect(renderHourly(computed)).toContain("3 job(s) across 24 hour(s)");
  });
});

describe("renderStatsJson hourly field", () => {
  it("omits `hourly` by default but includes it when provided", () => {
    const stats = computeStats([job()]);
    const without = JSON.parse(renderStatsJson(stats, "/tmp/s.json", { generatedAt: "x" }));
    expect("hourly" in without).toBe(false);
    const hourly = computeHourlyTrend([job({ createdAt: "2026-07-20T09:00:00.000Z" })]);
    const withHourly = JSON.parse(renderStatsJson(stats, "/tmp/s.json", { generatedAt: "x", hourly }));
    expect(withHourly.hourly).toEqual(hourly);
    expect(withHourly.hourly[9].count).toBe(1);
  });
});
