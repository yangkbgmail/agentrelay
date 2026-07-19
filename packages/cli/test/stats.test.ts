import type { RelayJob } from "@agentrelay/core";
import { computeGroupedStats, computeStats } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  formatDurationMs,
  formatSuccessRate,
  NO_SCOPE_MATCH_MESSAGE,
  NO_STATS_MESSAGE,
  renderGroupedStats,
  renderGroupedStatsJson,
  renderStats,
  renderStatsJson,
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
  it("renders one block per group with a header count", () => {
    const jobs = [
      job({ tool: "claude-code", status: "completed" }),
      job({ tool: "claude-code", status: "failed" }),
      job({ tool: "codex-cli", status: "completed" }),
    ];
    const grouped = computeGroupedStats(jobs, "tool");
    const out = renderGroupedStats(grouped, { now: NOW });
    expect(out).toContain("by tool (2 group(s))");
    expect(out).toContain("claude-code");
    expect(out).toContain("codex-cli");
    // claude-code group: 1/2 resolved success, one retry column present.
    expect(out).toContain("success rate: 50%");
  });

  it("shows the onboarding hint for an empty store, no-match when scoped", () => {
    const empty = computeGroupedStats([], "project");
    expect(renderGroupedStats(empty)).toBe(NO_STATS_MESSAGE);
    expect(renderGroupedStats(empty, { scopeNote: "project=nope" })).toBe(NO_SCOPE_MATCH_MESSAGE);
  });

  it("renders a per-group resolution line only when the group has resolved jobs", () => {
    const grouped = computeGroupedStats(
      [
        job({
          project: "web",
          status: "completed",
          createdAt: "2026-07-12T00:00:00.000Z",
          updatedAt: "2026-07-12T02:00:00.000Z",
        }),
        job({ project: "api", status: "queued" }),
      ],
      "project"
    );
    const out = renderGroupedStats(grouped, { now: NOW });
    // Groups tie at 1 job → key asc: "api" block first, then "web".
    const apiBlock = out.slice(out.indexOf("api"), out.indexOf("web"));
    const webBlock = out.slice(out.indexOf("web"));
    // web resolved → has a resolution line; api (queued only) → no resolution line.
    expect(webBlock).toContain("resolution: median");
    expect(apiBlock).not.toContain("resolution: median");
  });
});

describe("renderGroupedStatsJson", () => {
  it("emits the grouped breakdown and echoes an active scope", () => {
    const grouped = computeGroupedStats([job({ project: "demo" })], "project");
    const out = JSON.parse(
      renderGroupedStatsJson(grouped, "/store/jobs.json", {
        generatedAt: "2026-07-13T00:00:00.000Z",
        scope: { projects: ["demo"] },
      })
    );
    expect(out.grouped.dimension).toBe("project");
    expect(out.grouped.groups[0].key).toBe("demo");
    expect(out.scope).toEqual({ projects: ["demo"] });
  });

  it("omits an inactive (empty) scope", () => {
    const grouped = computeGroupedStats([job()], "tool");
    const out = JSON.parse(renderGroupedStatsJson(grouped, "/store/jobs.json", { generatedAt: "x", scope: {} }));
    expect(out.scope).toBeUndefined();
  });
});
