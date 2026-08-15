import { describe, expect, it } from "vitest";
import type { RateLimitDetection, RelayJob } from "./types.js";
import { computeRateLimitWindows } from "./windows.js";

const HOUR = 60 * 60 * 1000;

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "proj",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "waiting_for_reset",
    resetAt: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

/** A well-formed detection whose window is `hours` long starting at `detectedIso`. */
function detection(detectedIso: string, hours: number): RateLimitDetection {
  const resetMs = Date.parse(detectedIso) + hours * HOUR;
  return {
    pattern: "clock-time",
    rawMatch: "resets at ...",
    detectedAt: detectedIso,
    resetAt: new Date(resetMs).toISOString(),
  };
}

describe("computeRateLimitWindows", () => {
  it("returns an all-null distribution for an empty store", () => {
    const stats = computeRateLimitWindows([]);
    expect(stats.total).toBe(0);
    expect(stats.withWindow).toBe(0);
    expect(stats.withoutWindow).toBe(0);
    expect(stats.minMs).toBeNull();
    expect(stats.p95Ms).toBeNull();
  });

  it("counts jobs without a usable detection as withoutWindow", () => {
    const stats = computeRateLimitWindows([
      job({ lastRateLimit: null }),
      job({ lastRateLimit: undefined }),
      job({ lastRateLimit: detection("2026-08-15T00:00:00.000Z", 5) }),
    ]);
    expect(stats.total).toBe(3);
    expect(stats.withWindow).toBe(1);
    expect(stats.withoutWindow).toBe(2);
    expect(stats.minMs).toBe(5 * HOUR);
    expect(stats.maxMs).toBe(5 * HOUR);
    expect(stats.avgMs).toBe(5 * HOUR);
    expect(stats.medianMs).toBe(5 * HOUR);
  });

  it("computes min/max/avg/median/percentiles over multiple windows", () => {
    // windows of 1h, 3h, 5h, 7h, 9h
    const stats = computeRateLimitWindows([
      job({ lastRateLimit: detection("2026-08-15T00:00:00.000Z", 5) }),
      job({ lastRateLimit: detection("2026-08-15T00:00:00.000Z", 1) }),
      job({ lastRateLimit: detection("2026-08-15T00:00:00.000Z", 9) }),
      job({ lastRateLimit: detection("2026-08-15T00:00:00.000Z", 3) }),
      job({ lastRateLimit: detection("2026-08-15T00:00:00.000Z", 7) }),
    ]);
    expect(stats.withWindow).toBe(5);
    expect(stats.minMs).toBe(1 * HOUR);
    expect(stats.maxMs).toBe(9 * HOUR);
    expect(stats.avgMs).toBe(5 * HOUR); // (1+3+5+7+9)/5 = 5
    expect(stats.medianMs).toBe(5 * HOUR); // middle sample
    // type-7 p90 over [1,3,5,7,9]h: rank = 0.9*4 = 3.6 → 7 + 0.6*(9-7) = 8.2h
    expect(stats.p90Ms).toBe(Math.round(7 * HOUR + 0.6 * (9 * HOUR - 7 * HOUR)));
  });

  it("skips negative spans (reset already past / clock skew) as unusable", () => {
    const stale: RateLimitDetection = {
      pattern: "clock-time",
      rawMatch: "resets at 5pm",
      detectedAt: "2026-08-15T18:00:00.000Z",
      resetAt: "2026-08-15T17:00:00.000Z", // one hour BEFORE detection
    };
    const stats = computeRateLimitWindows([
      job({ lastRateLimit: stale }),
      job({ lastRateLimit: detection("2026-08-15T00:00:00.000Z", 2) }),
    ]);
    expect(stats.withWindow).toBe(1);
    expect(stats.withoutWindow).toBe(1);
    expect(stats.minMs).toBe(2 * HOUR);
  });

  it("skips detections with unparseable timestamps without throwing", () => {
    const bad: RateLimitDetection = {
      pattern: "iso",
      rawMatch: "garbage",
      detectedAt: "not-a-date",
      resetAt: "also-not-a-date",
    };
    const stats = computeRateLimitWindows([job({ lastRateLimit: bad })]);
    expect(stats.withWindow).toBe(0);
    expect(stats.withoutWindow).toBe(1);
    expect(stats.avgMs).toBeNull();
  });

  it("does not mutate the input job list order", () => {
    const jobs = [
      job({ lastRateLimit: detection("2026-08-15T00:00:00.000Z", 9) }),
      job({ lastRateLimit: detection("2026-08-15T00:00:00.000Z", 1) }),
    ];
    const ids = jobs.map((j) => j.id);
    computeRateLimitWindows(jobs);
    expect(jobs.map((j) => j.id)).toEqual(ids);
  });
});
