import { describe, expect, it } from "vitest";
import { summarizeRateLimitPatterns } from "./patterns.js";
import type { RateLimitDetection, RelayJob } from "./types.js";

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
    rawMatch: "resets at 5:30pm",
    resetAt: "2026-07-13T17:30:00.000Z",
    detectedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("summarizeRateLimitPatterns", () => {
  it("returns an empty shape for no jobs", () => {
    expect(summarizeRateLimitPatterns([])).toEqual({
      total: 0,
      withDetection: 0,
      withoutDetection: 0,
      patterns: [],
    });
  });

  it("counts jobs with no detection as withoutDetection", () => {
    const summary = summarizeRateLimitPatterns([job(), job({ lastRateLimit: null })]);
    expect(summary.total).toBe(2);
    expect(summary.withDetection).toBe(0);
    expect(summary.withoutDetection).toBe(2);
    expect(summary.patterns).toEqual([]);
  });

  it("aggregates detections per pattern", () => {
    const summary = summarizeRateLimitPatterns([
      job({ lastRateLimit: detection({ pattern: "clock-time" }) }),
      job({ lastRateLimit: detection({ pattern: "clock-time" }) }),
      job({ lastRateLimit: detection({ pattern: "relative-duration" }) }),
      job(), // no detection
    ]);
    expect(summary.total).toBe(4);
    expect(summary.withDetection).toBe(3);
    expect(summary.withoutDetection).toBe(1);
    expect(summary.patterns.map((p) => [p.pattern, p.count])).toEqual([
      ["clock-time", 2],
      ["relative-duration", 1],
    ]);
  });

  it("ranks by count desc, ties broken by pattern name asc", () => {
    const summary = summarizeRateLimitPatterns([
      job({ lastRateLimit: detection({ pattern: "zeta" }) }),
      job({ lastRateLimit: detection({ pattern: "alpha" }) }),
      job({ lastRateLimit: detection({ pattern: "beta" }) }),
      job({ lastRateLimit: detection({ pattern: "beta" }) }),
    ]);
    expect(summary.patterns.map((p) => p.pattern)).toEqual(["beta", "alpha", "zeta"]);
  });

  it("keeps the most-recent detectedAt and its raw sample within a pattern", () => {
    const summary = summarizeRateLimitPatterns([
      job({
        lastRateLimit: detection({
          pattern: "clock-time",
          detectedAt: "2026-07-13T01:00:00.000Z",
          rawMatch: "older match",
        }),
      }),
      job({
        lastRateLimit: detection({
          pattern: "clock-time",
          detectedAt: "2026-07-13T09:00:00.000Z",
          rawMatch: "newest match",
        }),
      }),
      job({
        lastRateLimit: detection({
          pattern: "clock-time",
          detectedAt: "2026-07-13T05:00:00.000Z",
          rawMatch: "middle match",
        }),
      }),
    ]);
    expect(summary.patterns).toHaveLength(1);
    expect(summary.patterns[0].count).toBe(3);
    expect(summary.patterns[0].lastDetectedAt).toBe("2026-07-13T09:00:00.000Z");
    expect(summary.patterns[0].sampleRawMatch).toBe("newest match");
  });

  it("ignores a detection with an empty or missing pattern name", () => {
    const summary = summarizeRateLimitPatterns([
      job({ lastRateLimit: detection({ pattern: "" }) }),
      // biome-ignore lint/suspicious/noExplicitAny: exercising a malformed record loaded from an old store
      job({ lastRateLimit: { rawMatch: "x", resetAt: "y", detectedAt: "z" } as any }),
      job({ lastRateLimit: detection({ pattern: "clock-time" }) }),
    ]);
    expect(summary.withDetection).toBe(1);
    expect(summary.withoutDetection).toBe(2);
    expect(summary.patterns).toEqual([
      {
        pattern: "clock-time",
        count: 1,
        lastDetectedAt: "2026-07-13T00:00:00.000Z",
        sampleRawMatch: "resets at 5:30pm",
      },
    ]);
  });

  it("tolerates a malformed detectedAt without throwing (sorts as oldest)", () => {
    const summary = summarizeRateLimitPatterns([
      job({ lastRateLimit: detection({ pattern: "clock-time", detectedAt: "not-a-date", rawMatch: "bad" }) }),
      job({
        lastRateLimit: detection({ pattern: "clock-time", detectedAt: "2026-07-13T02:00:00.000Z", rawMatch: "good" }),
      }),
    ]);
    expect(summary.patterns[0].count).toBe(2);
    // The parseable, later timestamp wins the "most recent" slot.
    expect(summary.patterns[0].lastDetectedAt).toBe("2026-07-13T02:00:00.000Z");
    expect(summary.patterns[0].sampleRawMatch).toBe("good");
  });

  it("does not mutate the input jobs", () => {
    const jobs = [job({ lastRateLimit: detection() })];
    const snapshot = JSON.parse(JSON.stringify(jobs));
    summarizeRateLimitPatterns(jobs);
    expect(jobs).toEqual(snapshot);
  });
});
