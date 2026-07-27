import { describe, expect, it } from "vitest";
import type { RateLimitDetection, RelayJob } from "./types.js";
import { computeWaitTime } from "./waittime.js";

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
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function detection(overrides: Partial<RateLimitDetection> = {}): RateLimitDetection {
  return {
    pattern: "clock-time",
    rawMatch: "resets at 5pm",
    // 1 hour wait by default.
    detectedAt: "2026-07-13T00:00:00.000Z",
    resetAt: "2026-07-13T01:00:00.000Z",
    ...overrides,
  };
}

const HOUR = 60 * 60 * 1000;

describe("computeWaitTime", () => {
  it("returns an empty shape for no jobs", () => {
    expect(computeWaitTime([])).toEqual({
      total: 0,
      withWait: 0,
      withoutWait: 0,
      totalWaitMs: 0,
      avgWaitMs: null,
      minWaitMs: null,
      maxWaitMs: null,
      longestJobId: null,
    });
  });

  it("counts a single wait span (resetAt − detectedAt)", () => {
    const stats = computeWaitTime([job({ lastRateLimit: detection() })]);
    expect(stats.withWait).toBe(1);
    expect(stats.totalWaitMs).toBe(HOUR);
    expect(stats.avgWaitMs).toBe(HOUR);
    expect(stats.minWaitMs).toBe(HOUR);
    expect(stats.maxWaitMs).toBe(HOUR);
  });

  it("sums spans across jobs and reports avg/min/max", () => {
    const stats = computeWaitTime([
      job({ lastRateLimit: detection({ resetAt: "2026-07-13T01:00:00.000Z" }) }), // 1h
      job({ lastRateLimit: detection({ resetAt: "2026-07-13T03:00:00.000Z" }) }), // 3h
    ]);
    expect(stats.total).toBe(2);
    expect(stats.withWait).toBe(2);
    expect(stats.totalWaitMs).toBe(4 * HOUR);
    expect(stats.avgWaitMs).toBe(2 * HOUR);
    expect(stats.minWaitMs).toBe(HOUR);
    expect(stats.maxWaitMs).toBe(3 * HOUR);
  });

  it("attributes longestJobId to the job with the max wait", () => {
    const stats = computeWaitTime([
      job({ id: "short", lastRateLimit: detection({ resetAt: "2026-07-13T00:30:00.000Z" }) }),
      job({ id: "long", lastRateLimit: detection({ resetAt: "2026-07-13T05:00:00.000Z" }) }),
    ]);
    expect(stats.longestJobId).toBe("long");
    expect(stats.maxWaitMs).toBe(5 * HOUR);
  });

  it("keeps the first job on a tie for longest", () => {
    const stats = computeWaitTime([
      job({ id: "first", lastRateLimit: detection() }),
      job({ id: "second", lastRateLimit: detection() }),
    ]);
    expect(stats.longestJobId).toBe("first");
  });

  it("counts jobs without a detection as withoutWait", () => {
    const stats = computeWaitTime([
      job({ lastRateLimit: null }),
      job({}), // lastRateLimit undefined (pre-provenance store)
      job({ lastRateLimit: detection() }),
    ]);
    expect(stats.total).toBe(3);
    expect(stats.withWait).toBe(1);
    expect(stats.withoutWait).toBe(2);
    expect(stats.totalWaitMs).toBe(HOUR);
  });

  it("drops spans with unparseable timestamps", () => {
    const stats = computeWaitTime([
      job({ lastRateLimit: detection({ detectedAt: "not-a-date" }) }),
      job({ lastRateLimit: detection({ resetAt: "" }) }),
      job({ lastRateLimit: detection() }),
    ]);
    expect(stats.withWait).toBe(1);
    expect(stats.withoutWait).toBe(2);
  });

  it("drops negative spans (reset already past at detection / clock skew)", () => {
    const stats = computeWaitTime([
      job({
        lastRateLimit: detection({
          detectedAt: "2026-07-13T05:00:00.000Z",
          resetAt: "2026-07-13T01:00:00.000Z",
        }),
      }),
    ]);
    expect(stats.withWait).toBe(0);
    expect(stats.totalWaitMs).toBe(0);
    expect(stats.avgWaitMs).toBeNull();
  });

  it("counts a zero-length span as a wait (min can be 0)", () => {
    const stats = computeWaitTime([job({ lastRateLimit: detection({ resetAt: "2026-07-13T00:00:00.000Z" }) })]);
    expect(stats.withWait).toBe(1);
    expect(stats.minWaitMs).toBe(0);
    expect(stats.maxWaitMs).toBe(0);
  });

  it("rounds the average to whole milliseconds", () => {
    const stats = computeWaitTime([
      job({ lastRateLimit: detection({ resetAt: "2026-07-13T00:00:01.000Z" }) }), // 1000ms
      job({ lastRateLimit: detection({ resetAt: "2026-07-13T00:00:02.000Z" }) }), // 2000ms
      job({ lastRateLimit: detection({ resetAt: "2026-07-13T00:00:02.000Z" }) }), // 2000ms
    ]);
    // (1000+2000+2000)/3 = 1666.66… -> 1667
    expect(stats.avgWaitMs).toBe(1667);
  });
});
