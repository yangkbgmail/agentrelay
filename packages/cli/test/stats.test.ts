import type { RelayJob } from "@agentrelay/core";
import { computeStats } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { formatSuccessRate, NO_STATS_MESSAGE, renderStats, renderStatsJson } from "../src/stats.js";

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
    const parsed = JSON.parse(renderStatsJson(stats, "/tmp/store.json", "2026-07-13T00:00:00.000Z"));
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-13T00:00:00.000Z");
    expect(parsed.stats.total).toBe(2);
    expect(parsed.stats.successRate).toBeCloseTo(0.5, 10);
  });
});
