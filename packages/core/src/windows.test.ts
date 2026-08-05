import { describe, expect, it } from "vitest";
import type { RateLimitDetection, RelayJob } from "./types.js";
import { DEFAULT_WINDOW_LIMIT, jobWaitWindow, summarizeRateLimitWindows, UNKNOWN_PATTERN_LABEL } from "./windows.js";

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

/** A detection whose window is exactly `hours` long. */
function detection(hours: number, overrides: Partial<RateLimitDetection> = {}): RateLimitDetection {
  const detectedAt = "2026-07-13T00:00:00.000Z";
  const resetAt = new Date(Date.parse(detectedAt) + hours * 3_600_000).toISOString();
  return { pattern: "clock-time", rawMatch: "resets at 5pm", detectedAt, resetAt, ...overrides };
}

describe("jobWaitWindow", () => {
  it("returns null when the job carries no detection", () => {
    expect(jobWaitWindow(job({ lastRateLimit: null }))).toBeNull();
    expect(jobWaitWindow(job({}))).toBeNull();
  });

  it("computes waitMs as resetAt − detectedAt", () => {
    const w = jobWaitWindow(job({ lastRateLimit: detection(2) }));
    expect(w).not.toBeNull();
    expect(w?.waitMs).toBe(2 * 3_600_000);
    expect(w?.pattern).toBe("clock-time");
    expect(w?.project).toBe("proj");
  });

  it("drops a negative span (clock skew) instead of clamping", () => {
    expect(jobWaitWindow(job({ lastRateLimit: detection(-1) }))).toBeNull();
  });

  it("drops unparseable timestamps", () => {
    expect(jobWaitWindow(job({ lastRateLimit: detection(1, { detectedAt: "not-a-date" }) }))).toBeNull();
    expect(jobWaitWindow(job({ lastRateLimit: detection(1, { resetAt: "" }) }))).toBeNull();
  });

  it("buckets an empty pattern name under the unknown label", () => {
    const w = jobWaitWindow(job({ lastRateLimit: detection(1, { pattern: "" }) }));
    expect(w?.pattern).toBe(UNKNOWN_PATTERN_LABEL);
  });

  it("keeps a zero-length window (reset == detection)", () => {
    const w = jobWaitWindow(job({ lastRateLimit: detection(0) }));
    expect(w?.waitMs).toBe(0);
  });
});

describe("summarizeRateLimitWindows", () => {
  it("returns an empty shape for no jobs", () => {
    expect(summarizeRateLimitWindows([])).toEqual({
      total: 0,
      withWindow: 0,
      withoutWindow: 0,
      totalWaitMs: 0,
      avgWaitMs: null,
      minWaitMs: null,
      maxWaitMs: null,
      medianWaitMs: null,
      p90WaitMs: null,
      byPattern: [],
      longest: [],
    });
  });

  it("counts jobs without a usable window as withoutWindow", () => {
    const summary = summarizeRateLimitWindows([job({}), job({ lastRateLimit: detection(-5) })]);
    expect(summary.total).toBe(2);
    expect(summary.withWindow).toBe(0);
    expect(summary.withoutWindow).toBe(2);
    expect(summary.byPattern).toEqual([]);
  });

  it("aggregates totals, avg, and extremes across windows", () => {
    const summary = summarizeRateLimitWindows([
      job({ lastRateLimit: detection(1) }),
      job({ lastRateLimit: detection(3) }),
      job({ lastRateLimit: detection(2) }),
    ]);
    const h = 3_600_000;
    expect(summary.withWindow).toBe(3);
    expect(summary.totalWaitMs).toBe(6 * h);
    expect(summary.avgWaitMs).toBe(2 * h);
    expect(summary.minWaitMs).toBe(1 * h);
    expect(summary.maxWaitMs).toBe(3 * h);
    expect(summary.medianWaitMs).toBe(2 * h);
  });

  it("computes p90 with type-7 linear interpolation", () => {
    // windows 0..10 hours → p90 rank = 0.9·10 = 9 → exactly the 9h sample.
    const jobs = Array.from({ length: 11 }, (_, i) => job({ lastRateLimit: detection(i) }));
    const summary = summarizeRateLimitWindows(jobs);
    expect(summary.p90WaitMs).toBe(9 * 3_600_000);
    expect(summary.medianWaitMs).toBe(5 * 3_600_000);
  });

  it("rolls up per-pattern totals ranked by total wait desc", () => {
    const summary = summarizeRateLimitWindows([
      job({ lastRateLimit: detection(1, { pattern: "clock-time" }) }),
      job({ lastRateLimit: detection(5, { pattern: "relative-duration" }) }),
      job({ lastRateLimit: detection(2, { pattern: "clock-time" }) }),
    ]);
    expect(summary.byPattern).toEqual([
      { pattern: "relative-duration", count: 1, totalWaitMs: 5 * 3_600_000, avgWaitMs: 5 * 3_600_000 },
      { pattern: "clock-time", count: 2, totalWaitMs: 3 * 3_600_000, avgWaitMs: 1.5 * 3_600_000 },
    ]);
  });

  it("returns the longest windows first, capped at the default limit", () => {
    const jobs = Array.from({ length: 8 }, (_, i) => job({ id: `j${i}`, lastRateLimit: detection(i + 1) }));
    const summary = summarizeRateLimitWindows(jobs);
    expect(summary.longest).toHaveLength(DEFAULT_WINDOW_LIMIT);
    expect(summary.longest.map((w) => w.waitMs)).toEqual([8, 7, 6, 5, 4].map((h) => h * 3_600_000));
    // Totals still reflect ALL windows, not just the capped longest set.
    expect(summary.withWindow).toBe(8);
  });

  it("returns every window when limit is 0", () => {
    const jobs = Array.from({ length: 8 }, (_, i) => job({ lastRateLimit: detection(i + 1) }));
    expect(summarizeRateLimitWindows(jobs, { limit: 0 }).longest).toHaveLength(8);
  });

  it("breaks longest ties by jobId ascending", () => {
    const summary = summarizeRateLimitWindows([
      job({ id: "b", lastRateLimit: detection(2) }),
      job({ id: "a", lastRateLimit: detection(2) }),
    ]);
    expect(summary.longest.map((w) => w.jobId)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const jobs = [job({ lastRateLimit: detection(3) }), job({ lastRateLimit: detection(1) })];
    const before = jobs.map((j) => j.id);
    summarizeRateLimitWindows(jobs);
    expect(jobs.map((j) => j.id)).toEqual(before);
  });
});
