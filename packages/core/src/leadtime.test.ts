import { describe, expect, it } from "vitest";
import { computeLeadTimes } from "./leadtime.js";
import type { RateLimitDetection, RelayJob } from "./types.js";

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
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

/** A detection whose lead time (resetAt − detectedAt) is exactly `leadMs`. */
function detection(leadMs: number, overrides: Partial<RateLimitDetection> = {}): RateLimitDetection {
  const detectedAt = "2026-07-13T00:00:00.000Z";
  const resetAt = new Date(Date.parse(detectedAt) + leadMs).toISOString();
  return { pattern: "clock-time", rawMatch: "resets at 5pm", resetAt, detectedAt, ...overrides };
}

describe("computeLeadTimes", () => {
  it("returns an all-null shape for no jobs", () => {
    expect(computeLeadTimes([])).toEqual({
      total: 0,
      withDetection: 0,
      withoutDetection: 0,
      count: 0,
      skipped: 0,
      avgMs: null,
      minMs: null,
      maxMs: null,
      medianMs: null,
      p90Ms: null,
      byPattern: [],
    });
  });

  it("counts jobs with no detection as withoutDetection and keeps stats null", () => {
    const summary = computeLeadTimes([job(), job({ lastRateLimit: null })]);
    expect(summary.total).toBe(2);
    expect(summary.withDetection).toBe(0);
    expect(summary.withoutDetection).toBe(2);
    expect(summary.count).toBe(0);
    expect(summary.avgMs).toBeNull();
    expect(summary.medianMs).toBeNull();
  });

  it("computes lead time as resetAt − detectedAt", () => {
    const summary = computeLeadTimes([job({ lastRateLimit: detection(5 * HOUR) })]);
    expect(summary.count).toBe(1);
    expect(summary.avgMs).toBe(5 * HOUR);
    expect(summary.minMs).toBe(5 * HOUR);
    expect(summary.maxMs).toBe(5 * HOUR);
    expect(summary.medianMs).toBe(5 * HOUR);
    expect(summary.p90Ms).toBe(5 * HOUR);
  });

  it("aggregates min/max/avg/median/p90 across samples", () => {
    // 1h, 2h, 3h, 4h, 5h → avg 3h, median 3h, p90 = interpolate rank 0.9·4=3.6 between 4h and 5h = 4.6h
    const summary = computeLeadTimes([
      job({ lastRateLimit: detection(1 * HOUR) }),
      job({ lastRateLimit: detection(2 * HOUR) }),
      job({ lastRateLimit: detection(3 * HOUR) }),
      job({ lastRateLimit: detection(4 * HOUR) }),
      job({ lastRateLimit: detection(5 * HOUR) }),
    ]);
    expect(summary.count).toBe(5);
    expect(summary.minMs).toBe(1 * HOUR);
    expect(summary.maxMs).toBe(5 * HOUR);
    expect(summary.avgMs).toBe(3 * HOUR);
    expect(summary.medianMs).toBe(3 * HOUR);
    expect(summary.p90Ms).toBe(Math.round(4.6 * HOUR));
  });

  it("allows a zero-length window (reset == detection) as a valid sample", () => {
    const summary = computeLeadTimes([job({ lastRateLimit: detection(0) })]);
    expect(summary.count).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.minMs).toBe(0);
  });

  it("skips (does not clamp) a negative window from clock skew", () => {
    const summary = computeLeadTimes([
      job({ lastRateLimit: detection(-2 * HOUR) }),
      job({ lastRateLimit: detection(3 * HOUR) }),
    ]);
    expect(summary.withDetection).toBe(2);
    expect(summary.count).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.avgMs).toBe(3 * HOUR);
  });

  it("skips a detection with unparseable timestamps but still counts it as withDetection", () => {
    const summary = computeLeadTimes([
      job({ lastRateLimit: detection(4 * HOUR, { detectedAt: "not-a-date" }) }),
      job({ lastRateLimit: detection(4 * HOUR, { resetAt: "nope" }) }),
      job({ lastRateLimit: detection(4 * HOUR) }),
    ]);
    expect(summary.withDetection).toBe(3);
    expect(summary.count).toBe(1);
    expect(summary.skipped).toBe(2);
  });

  it("ignores a detection with an empty or missing pattern name", () => {
    const summary = computeLeadTimes([
      job({ lastRateLimit: detection(2 * HOUR, { pattern: "" }) }),
      // biome-ignore lint/suspicious/noExplicitAny: exercising a malformed record loaded from an old store
      job({ lastRateLimit: { rawMatch: "x", resetAt: "y", detectedAt: "z" } as any }),
      job({ lastRateLimit: detection(2 * HOUR) }),
    ]);
    expect(summary.withDetection).toBe(1);
    expect(summary.withoutDetection).toBe(2);
    expect(summary.count).toBe(1);
  });

  it("breaks lead time down per pattern, ranked by count desc then name asc", () => {
    const summary = computeLeadTimes([
      job({ lastRateLimit: detection(1 * HOUR, { pattern: "relative-duration" }) }),
      job({ lastRateLimit: detection(3 * HOUR, { pattern: "relative-duration" }) }),
      job({ lastRateLimit: detection(5 * HOUR, { pattern: "five-hour-window-fallback" }) }),
      job({ lastRateLimit: detection(5 * HOUR, { pattern: "five-hour-window-fallback" }) }),
    ]);
    expect(summary.byPattern.map((p) => [p.pattern, p.count])).toEqual([
      ["five-hour-window-fallback", 2],
      ["relative-duration", 2],
    ]);
    const relative = summary.byPattern.find((p) => p.pattern === "relative-duration");
    expect(relative).toMatchObject({ avgMs: 2 * HOUR, minMs: 1 * HOUR, maxMs: 3 * HOUR });
  });

  it("does not include a skipped sample in per-pattern aggregates", () => {
    const summary = computeLeadTimes([
      job({ lastRateLimit: detection(-1 * HOUR, { pattern: "clock-time" }) }),
      job({ lastRateLimit: detection(2 * HOUR, { pattern: "clock-time" }) }),
    ]);
    const clock = summary.byPattern.find((p) => p.pattern === "clock-time");
    expect(clock?.count).toBe(1);
    expect(clock?.avgMs).toBe(2 * HOUR);
  });

  it("does not mutate the input jobs", () => {
    const jobs = [job({ lastRateLimit: detection(2 * HOUR) })];
    const snapshot = JSON.parse(JSON.stringify(jobs));
    computeLeadTimes(jobs);
    expect(jobs).toEqual(snapshot);
  });
});
