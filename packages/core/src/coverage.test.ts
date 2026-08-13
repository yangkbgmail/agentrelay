import { describe, expect, it } from "vitest";
import { computeRelayCoverage } from "./coverage.js";
import type { RateLimitDetection, RelayJob } from "./types.js";

/** Minimal job builder; only the fields coverage reads matter. */
function job(overrides: Partial<RelayJob> & { id: string }): RelayJob {
  return {
    id: overrides.id,
    project: overrides.project ?? "proj",
    tool: overrides.tool ?? "claude-code",
    command: overrides.command ?? ["claude", "-p", "continue"],
    cwd: overrides.cwd ?? "/tmp",
    status: overrides.status ?? "waiting_for_reset",
    resetAt: overrides.resetAt ?? null,
    createdAt: overrides.createdAt ?? "2026-08-13T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-08-13T00:00:00.000Z",
    attempts: overrides.attempts ?? 1,
    lastError: overrides.lastError ?? null,
    lastOutputTail: overrides.lastOutputTail ?? null,
    lastRateLimit: overrides.lastRateLimit,
  };
}

function detection(overrides: Partial<RateLimitDetection> = {}): RateLimitDetection {
  return {
    pattern: overrides.pattern ?? "iso-timestamp",
    rawMatch: overrides.rawMatch ?? "reset at 2026-08-13T05:00:00Z",
    detectedAt: overrides.detectedAt ?? "2026-08-13T00:00:00.000Z",
    resetAt: overrides.resetAt ?? "2026-08-13T05:00:00.000Z",
  };
}

describe("computeRelayCoverage", () => {
  it("returns a zeroed, empty report for no jobs", () => {
    const c = computeRelayCoverage([]);
    expect(c).toEqual({
      windowCount: 0,
      totalWaitMs: 0,
      avgWaitMs: null,
      minWaitMs: null,
      maxWaitMs: null,
      medianWaitMs: null,
      p90WaitMs: null,
      longest: null,
      byPattern: [],
    });
  });

  it("ignores jobs with no detection at all", () => {
    const c = computeRelayCoverage([job({ id: "a", lastRateLimit: null }), job({ id: "b" })]);
    expect(c.windowCount).toBe(0);
    expect(c.totalWaitMs).toBe(0);
  });

  it("computes a single window as resetAt − detectedAt", () => {
    const c = computeRelayCoverage([
      job({
        id: "a",
        lastRateLimit: detection({
          detectedAt: "2026-08-13T00:00:00.000Z",
          resetAt: "2026-08-13T05:00:00.000Z",
        }),
      }),
    ]);
    const fiveHours = 5 * 60 * 60 * 1000;
    expect(c.windowCount).toBe(1);
    expect(c.totalWaitMs).toBe(fiveHours);
    expect(c.avgWaitMs).toBe(fiveHours);
    expect(c.minWaitMs).toBe(fiveHours);
    expect(c.maxWaitMs).toBe(fiveHours);
    expect(c.medianWaitMs).toBe(fiveHours);
    expect(c.p90WaitMs).toBe(fiveHours);
    expect(c.longest).toEqual({ jobId: "a", project: "proj", pattern: "iso-timestamp", waitMs: fiveHours });
  });

  it("aggregates min/max/avg/median/p90 across several windows", () => {
    const hour = 60 * 60 * 1000;
    const mk = (id: string, hours: number) =>
      job({
        id,
        lastRateLimit: detection({
          detectedAt: "2026-08-13T00:00:00.000Z",
          resetAt: new Date(Date.parse("2026-08-13T00:00:00.000Z") + hours * hour).toISOString(),
        }),
      });
    // windows: 1h, 2h, 3h, 4h
    const c = computeRelayCoverage([mk("a", 1), mk("b", 2), mk("c", 3), mk("d", 4)]);
    expect(c.windowCount).toBe(4);
    expect(c.totalWaitMs).toBe(10 * hour);
    expect(c.avgWaitMs).toBe(2.5 * hour);
    expect(c.minWaitMs).toBe(1 * hour);
    expect(c.maxWaitMs).toBe(4 * hour);
    // p50 over [1,2,3,4]h with rank 0.5·3 = 1.5 → interpolate 2h..3h → 2.5h
    expect(c.medianWaitMs).toBe(2.5 * hour);
    // p90 rank 0.9·3 = 2.7 → interpolate 3h..4h → 3.7h
    expect(c.p90WaitMs).toBe(3.7 * hour);
    expect(c.longest?.jobId).toBe("d");
  });

  it("clamps a reset that precedes detection to a zero window (no negatives)", () => {
    const c = computeRelayCoverage([
      job({
        id: "skew",
        lastRateLimit: detection({
          detectedAt: "2026-08-13T05:00:00.000Z",
          resetAt: "2026-08-13T00:00:00.000Z",
        }),
      }),
    ]);
    expect(c.windowCount).toBe(1);
    expect(c.totalWaitMs).toBe(0);
    expect(c.minWaitMs).toBe(0);
    expect(c.longest?.waitMs).toBe(0);
  });

  it("skips detections with an empty pattern or unparseable timestamps", () => {
    const c = computeRelayCoverage([
      job({ id: "empty-pattern", lastRateLimit: detection({ pattern: "" }) }),
      job({ id: "bad-detected", lastRateLimit: detection({ detectedAt: "not-a-date" }) }),
      job({ id: "bad-reset", lastRateLimit: detection({ resetAt: "nope" }) }),
      job({ id: "good", lastRateLimit: detection() }),
    ]);
    expect(c.windowCount).toBe(1);
    expect(c.longest?.jobId).toBe("good");
  });

  it("rolls up per pattern, ranked by total wait desc then name asc", () => {
    const hour = 60 * 60 * 1000;
    const mk = (id: string, pattern: string, hours: number) =>
      job({
        id,
        lastRateLimit: detection({
          pattern,
          detectedAt: "2026-08-13T00:00:00.000Z",
          resetAt: new Date(Date.parse("2026-08-13T00:00:00.000Z") + hours * hour).toISOString(),
        }),
      });
    const c = computeRelayCoverage([
      mk("a", "relative-duration", 1),
      mk("b", "relative-duration", 2),
      mk("c", "iso-timestamp", 3),
      // ties total (3h) with iso-timestamp → name asc puts clock-time first
      mk("d", "clock-time", 3),
    ]);
    expect(c.byPattern).toEqual([
      { pattern: "clock-time", count: 1, totalWaitMs: 3 * hour },
      { pattern: "iso-timestamp", count: 1, totalWaitMs: 3 * hour },
      { pattern: "relative-duration", count: 2, totalWaitMs: 3 * hour },
    ]);
  });

  it("keeps the first job on a longest-window tie (deterministic)", () => {
    const same = detection({
      detectedAt: "2026-08-13T00:00:00.000Z",
      resetAt: "2026-08-13T02:00:00.000Z",
    });
    const c = computeRelayCoverage([
      job({ id: "first", lastRateLimit: same }),
      job({ id: "second", lastRateLimit: same }),
    ]);
    expect(c.longest?.jobId).toBe("first");
  });
});
