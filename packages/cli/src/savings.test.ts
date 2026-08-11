import type { RelaySavings } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  formatSpan,
  NO_JOBS_MESSAGE,
  NO_SAVINGS_MESSAGE,
  NO_SCOPE_MATCH_MESSAGE,
  renderSavings,
  renderSavingsJson,
} from "./savings.js";

/** A RelaySavings with sensible zero defaults, overridable per test. */
function savings(overrides: Partial<RelaySavings> = {}): RelaySavings {
  return {
    total: 0,
    bridged: 0,
    totalBridgedMs: 0,
    averageBridgeMs: 0,
    longestBridgeMs: 0,
    longestBridgeJobId: null,
    byTool: [],
    ...overrides,
  };
}

const H = 3_600_000;

describe("formatSpan", () => {
  it("renders zero and negative as 0s", () => {
    expect(formatSpan(0)).toBe("0s");
    expect(formatSpan(-5)).toBe("0s");
    expect(formatSpan(Number.NaN)).toBe("0s");
  });

  it("picks the two most-significant units across the range", () => {
    expect(formatSpan(45_000)).toBe("45s");
    expect(formatSpan(90_000)).toBe("1m 30s");
    expect(formatSpan(2 * H + 34 * 60_000)).toBe("2h 34m");
    expect(formatSpan(26 * H)).toBe("1d 2h");
  });
});

describe("renderSavings", () => {
  it("shows the empty-store hint when there are no jobs", () => {
    expect(renderSavings(savings())).toBe(NO_JOBS_MESSAGE);
  });

  it("shows the scope-miss hint when a filter matched nothing", () => {
    const out = renderSavings(savings(), { scopeNote: "project=web" });
    expect(out).toContain("scope: project=web");
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
  });

  it("shows the no-savings hint when jobs exist but none were bridged", () => {
    const out = renderSavings(savings({ total: 3 }));
    expect(out).toContain(NO_SAVINGS_MESSAGE);
    expect(out).toContain("3 job(s) tracked, 0 with a bridged rate-limit window");
  });

  it("headlines the total bridged wait and the bridge count", () => {
    const out = renderSavings(
      savings({
        total: 4,
        bridged: 3,
        totalBridgedMs: 8 * H,
        averageBridgeMs: (8 / 3) * H,
        longestBridgeMs: 5 * H,
        longestBridgeJobId: "abcdef0123456789",
      })
    );
    expect(out).toContain("AgentRelay waited 8h 0m for you");
    expect(out).toContain("across 3 rate-limit(s)");
    expect(out).toContain("4 job(s) tracked; 1 without a bridged window");
    expect(out).toContain("longest window  5h 0m");
    // longest job id is shown truncated to 8 chars
    expect(out).toContain("(abcdef01)");
  });

  it("renders a per-tool breakdown with job counts", () => {
    const out = renderSavings(
      savings({
        total: 3,
        bridged: 3,
        totalBridgedMs: 6 * H,
        averageBridgeMs: 2 * H,
        longestBridgeMs: 4 * H,
        longestBridgeJobId: "x",
        byTool: [
          { tool: "codex-cli", jobs: 1, bridgedMs: 4 * H },
          { tool: "claude-code", jobs: 2, bridgedMs: 2 * H },
        ],
      })
    );
    expect(out).toContain("by tool");
    expect(out).toContain("codex-cli");
    expect(out).toContain("claude-code");
    expect(out).toContain("2 job(s)");
  });

  it("gates ANSI color codes on the color flag", () => {
    const plain = renderSavings(savings({ total: 1, bridged: 1, totalBridgedMs: H }), { color: false });
    const colored = renderSavings(savings({ total: 1, bridged: 1, totalBridgedMs: H }), { color: true });
    expect(plain).not.toContain("\x1b[");
    expect(colored).toContain("\x1b[");
  });
});

describe("renderSavingsJson", () => {
  it("emits the store path, generatedAt, scope, and full report", () => {
    const report = savings({ total: 2, bridged: 1, totalBridgedMs: H, longestBridgeMs: H, longestBridgeJobId: "id" });
    const json = JSON.parse(
      renderSavingsJson({
        storePath: "/tmp/jobs.json",
        generatedAt: "2026-08-11T00:00:00.000Z",
        scope: { projects: ["web"] },
        savings: report,
      })
    );
    expect(json.storePath).toBe("/tmp/jobs.json");
    expect(json.generatedAt).toBe("2026-08-11T00:00:00.000Z");
    expect(json.scope).toEqual({ projects: ["web"] });
    expect(json.savings.totalBridgedMs).toBe(H);
    expect(json.savings.bridged).toBe(1);
  });
});
