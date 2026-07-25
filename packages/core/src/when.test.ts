import { describe, expect, it } from "vitest";
import type { RateLimitDetection, RelayJob } from "./types.js";
import { hourlyRateLimitDistribution } from "./when.js";

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
    detectedAt: "2026-07-13T09:00:00.000Z",
    ...overrides,
  };
}

/** Sum every bucket's count — should always equal `withDetection`. */
function bucketTotal(buckets: { count: number }[]): number {
  return buckets.reduce((s, b) => s + b.count, 0);
}

describe("hourlyRateLimitDistribution", () => {
  it("returns a zero-filled 24-bucket shape for no jobs", () => {
    const dist = hourlyRateLimitDistribution([]);
    expect(dist.total).toBe(0);
    expect(dist.withDetection).toBe(0);
    expect(dist.withoutDetection).toBe(0);
    expect(dist.utcOffsetMinutes).toBe(0);
    expect(dist.buckets).toHaveLength(24);
    expect(dist.buckets.map((b) => b.hour)).toEqual([...Array(24).keys()]);
    expect(bucketTotal(dist.buckets)).toBe(0);
    expect(dist.peakHour).toBeNull();
    expect(dist.peakCount).toBe(0);
  });

  it("buckets a detection by its UTC hour when no offset is given", () => {
    const dist = hourlyRateLimitDistribution([
      job({ lastRateLimit: detection({ detectedAt: "2026-07-13T09:15:00.000Z" }) }),
    ]);
    expect(dist.withDetection).toBe(1);
    expect(dist.buckets[9].count).toBe(1);
    expect(dist.peakHour).toBe(9);
    expect(dist.peakCount).toBe(1);
    expect(bucketTotal(dist.buckets)).toBe(1);
  });

  it("shifts hours by a positive (east of UTC) offset", () => {
    // 23:30 UTC + 9h (Tokyo) -> 08:30 next day -> hour 8.
    const dist = hourlyRateLimitDistribution(
      [job({ lastRateLimit: detection({ detectedAt: "2026-07-13T23:30:00.000Z" }) })],
      { utcOffsetMinutes: 9 * 60 }
    );
    expect(dist.utcOffsetMinutes).toBe(540);
    expect(dist.buckets[8].count).toBe(1);
    expect(dist.peakHour).toBe(8);
  });

  it("shifts hours by a negative (west of UTC) offset, wrapping across midnight", () => {
    // 02:30 UTC - 8h (US Pacific) -> 18:30 previous day -> hour 18.
    const dist = hourlyRateLimitDistribution(
      [job({ lastRateLimit: detection({ detectedAt: "2026-07-13T02:30:00.000Z" }) })],
      { utcOffsetMinutes: -8 * 60 }
    );
    expect(dist.buckets[18].count).toBe(1);
    expect(dist.peakHour).toBe(18);
  });

  it("counts multiple detections into the same and different buckets", () => {
    const dist = hourlyRateLimitDistribution([
      job({ lastRateLimit: detection({ detectedAt: "2026-07-13T09:00:00.000Z" }) }),
      job({ lastRateLimit: detection({ detectedAt: "2026-07-13T09:59:59.000Z" }) }),
      job({ lastRateLimit: detection({ detectedAt: "2026-07-13T14:05:00.000Z" }) }),
    ]);
    expect(dist.withDetection).toBe(3);
    expect(dist.buckets[9].count).toBe(2);
    expect(dist.buckets[14].count).toBe(1);
    expect(dist.peakHour).toBe(9);
    expect(dist.peakCount).toBe(2);
    expect(bucketTotal(dist.buckets)).toBe(3);
  });

  it("breaks a peak tie toward the earliest hour", () => {
    const dist = hourlyRateLimitDistribution([
      job({ lastRateLimit: detection({ detectedAt: "2026-07-13T20:00:00.000Z" }) }),
      job({ lastRateLimit: detection({ detectedAt: "2026-07-13T06:00:00.000Z" }) }),
    ]);
    expect(dist.peakCount).toBe(1);
    expect(dist.peakHour).toBe(6);
  });

  it("treats jobs without a usable detection as withoutDetection", () => {
    const dist = hourlyRateLimitDistribution([
      job({ lastRateLimit: null }),
      job({ lastRateLimit: undefined }),
      job({ lastRateLimit: detection({ detectedAt: "" }) }),
      job({ lastRateLimit: detection({ detectedAt: "not-a-date" }) }),
      job({ lastRateLimit: detection({ detectedAt: "2026-07-13T09:00:00.000Z" }) }),
    ]);
    expect(dist.total).toBe(5);
    expect(dist.withDetection).toBe(1);
    expect(dist.withoutDetection).toBe(4);
    expect(bucketTotal(dist.buckets)).toBe(1);
  });

  it("normalises a non-finite offset to 0 (UTC) rather than poisoning buckets", () => {
    const dist = hourlyRateLimitDistribution(
      [job({ lastRateLimit: detection({ detectedAt: "2026-07-13T09:00:00.000Z" }) })],
      { utcOffsetMinutes: Number.NaN }
    );
    expect(dist.utcOffsetMinutes).toBe(0);
    expect(dist.buckets[9].count).toBe(1);
  });

  it("handles a fractional (30-minute) offset like India", () => {
    // 22:00 UTC + 5h30 -> 03:30 -> hour 3.
    const dist = hourlyRateLimitDistribution(
      [job({ lastRateLimit: detection({ detectedAt: "2026-07-13T22:00:00.000Z" }) })],
      { utcOffsetMinutes: 330 }
    );
    expect(dist.buckets[3].count).toBe(1);
  });
});
