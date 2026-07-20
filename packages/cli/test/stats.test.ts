import type { RelayJob } from "@agentrelay/core";
import { computeStats, groupStats } from "@agentrelay/core";
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
  it("shows the onboarding hint for an empty (unscoped) store", () => {
    expect(renderGroupedStats([], "tool")).toBe(NO_STATS_MESSAGE);
  });

  it("shows the no-match message for an empty scoped subset", () => {
    expect(renderGroupedStats([], "tool", { scopeNote: "project=nope" })).toBe(NO_SCOPE_MATCH_MESSAGE);
  });

  it("renders a header, column row, and one line per group in rank order", () => {
    const jobs = [
      job({ tool: "claude-code", status: "completed" }),
      job({ tool: "claude-code", status: "failed" }),
      job({ tool: "codex-cli", status: "completed" }),
    ];
    const out = renderGroupedStats(groupStats(jobs, "tool"), "tool", { now: NOW });
    expect(out).toContain("grouped by tool");
    expect(out).toContain("(2 group(s))");
    // claude-code (2 jobs) ranks above codex-cli (1 job).
    const claudeIdx = out.indexOf("claude-code");
    const codexIdx = out.indexOf("codex-cli");
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(codexIdx).toBeGreaterThan(claudeIdx);
    // Per-group success rate is shown (claude-code: 1/2 resolved = 50%).
    expect(out).toContain("50%");
    expect(out).toContain("100%");
  });

  it("prepends a scope note when given", () => {
    const out = renderGroupedStats(groupStats([job()], "project"), "project", { scopeNote: "tool=claude-code" });
    expect(out).toContain("scope: tool=claude-code");
  });
});

describe("renderGroupedStatsJson", () => {
  it("emits groupBy, groups, and echoes an active scope", () => {
    const groups = groupStats([job({ tool: "codex-cli" }), job({ tool: "claude-code" })], "tool");
    const out = JSON.parse(
      renderGroupedStatsJson(groups, "tool", "/tmp/store.json", {
        generatedAt: "2026-07-13T00:00:00.000Z",
        scope: { tools: ["codex-cli", "claude-code"] },
      })
    );
    expect(out.groupBy).toBe("tool");
    expect(out.storePath).toBe("/tmp/store.json");
    expect(out.scope).toEqual({ tools: ["codex-cli", "claude-code"] });
    expect(out.groups.map((g: { key: string }) => g.key).sort()).toEqual(["claude-code", "codex-cli"]);
    expect(out.groups[0].stats.total).toBe(1);
  });

  it("omits an inactive (empty) scope", () => {
    const out = JSON.parse(
      renderGroupedStatsJson(groupStats([job()], "status"), "status", "/tmp/s.json", {
        generatedAt: "2026-07-13T00:00:00.000Z",
      })
    );
    expect(out.scope).toBeUndefined();
  });
});
