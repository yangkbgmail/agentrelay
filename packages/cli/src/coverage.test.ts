import type { RelayCoverage } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  NO_COVERAGE_MESSAGE,
  NO_COVERAGE_SCOPE_MATCH_MESSAGE,
  renderCoverage,
  renderCoverageJson,
} from "./coverage.js";

const HOUR = 60 * 60 * 1000;

function sample(overrides: Partial<RelayCoverage> = {}): RelayCoverage {
  return {
    windowCount: overrides.windowCount ?? 3,
    totalWaitMs: overrides.totalWaitMs ?? 6 * HOUR,
    avgWaitMs: overrides.avgWaitMs ?? 2 * HOUR,
    minWaitMs: overrides.minWaitMs ?? 1 * HOUR,
    maxWaitMs: overrides.maxWaitMs ?? 3 * HOUR,
    medianWaitMs: overrides.medianWaitMs ?? 2 * HOUR,
    p90WaitMs: overrides.p90WaitMs ?? 3 * HOUR,
    longest: overrides.longest ?? {
      jobId: "abcdef1234",
      project: "webapp",
      pattern: "iso-timestamp",
      waitMs: 3 * HOUR,
    },
    byPattern: overrides.byPattern ?? [
      { pattern: "iso-timestamp", count: 2, totalWaitMs: 4 * HOUR },
      { pattern: "relative-duration", count: 1, totalWaitMs: 2 * HOUR },
    ],
  };
}

const EMPTY: RelayCoverage = {
  windowCount: 0,
  totalWaitMs: 0,
  avgWaitMs: null,
  minWaitMs: null,
  maxWaitMs: null,
  medianWaitMs: null,
  p90WaitMs: null,
  longest: null,
  byPattern: [],
};

describe("renderCoverage", () => {
  it("shows the onboarding hint when nothing is recorded", () => {
    expect(renderCoverage(EMPTY)).toBe(NO_COVERAGE_MESSAGE);
  });

  it("shows the no-match hint when a scope filtered everything out", () => {
    expect(renderCoverage(EMPTY, { scopeNote: "project=webapp" })).toBe(NO_COVERAGE_SCOPE_MATCH_MESSAGE);
  });

  it("renders the headline total, per-window stats, longest and pattern breakdown", () => {
    const out = renderCoverage(sample());
    expect(out).toContain("6h 0m of rate-limit wait covered");
    expect(out).toContain("across 3 window(s)");
    expect(out).toContain("avg 2h 0m");
    expect(out).toContain("min 1h 0m");
    expect(out).toContain("max 3h 0m");
    expect(out).toContain("median 2h 0m");
    expect(out).toContain("p90 3h 0m");
    expect(out).toContain("longest 3h 0m");
    expect(out).toContain("webapp");
    expect(out).toContain("iso-timestamp");
    // job id is truncated to 8 chars in the longest callout
    expect(out).toContain("abcdef12");
    // pattern breakdown lines
    expect(out).toContain("relative-duration");
    expect(out).toContain("(2 windows)");
    expect(out).toContain("(1 window)");
  });

  it("prefixes a scope note when scoped", () => {
    const out = renderCoverage(sample(), { scopeNote: "tool=claude-code" });
    expect(out.split("\n")[0]).toContain("scope: tool=claude-code");
  });

  it("emits no ANSI codes when color is off", () => {
    expect(renderCoverage(sample())).not.toContain("\x1b[");
  });

  it("emits ANSI codes when color is on", () => {
    expect(renderCoverage(sample(), { color: true })).toContain("\x1b[");
  });
});

describe("renderCoverageJson", () => {
  it("wraps coverage with store path and a fixed generatedAt", () => {
    const json = JSON.parse(
      renderCoverageJson(sample(), "/store/jobs.json", { generatedAt: "2026-08-13T00:00:00.000Z" })
    );
    expect(json.storePath).toBe("/store/jobs.json");
    expect(json.generatedAt).toBe("2026-08-13T00:00:00.000Z");
    expect(json.coverage.windowCount).toBe(3);
    expect(json.scope).toBeUndefined();
  });

  it("echoes an active scope but omits an inactive one", () => {
    const active = JSON.parse(
      renderCoverageJson(sample(), "/s", { generatedAt: "2026-08-13T00:00:00.000Z", scope: { projects: ["webapp"] } })
    );
    expect(active.scope).toEqual({ projects: ["webapp"] });

    const inactive = JSON.parse(
      renderCoverageJson(sample(), "/s", { generatedAt: "2026-08-13T00:00:00.000Z", scope: {} })
    );
    expect(inactive.scope).toBeUndefined();
  });
});
