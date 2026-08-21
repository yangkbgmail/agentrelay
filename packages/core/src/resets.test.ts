import { describe, expect, it } from "vitest";
import { computeResetClock, RESET_CLOCK_BASES } from "./resets.js";
import type { RateLimitDetection, RelayJob } from "./types.js";

let seq = 0;
function detection(overrides: Partial<RateLimitDetection> = {}): RateLimitDetection {
  return {
    pattern: "iso-timestamp",
    rawMatch: "resets at 2026-07-30T15:00:00Z",
    resetAt: "2026-07-30T15:00:00.000Z",
    detectedAt: "2026-07-30T10:00:00.000Z",
    ...overrides,
  };
}

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "waiting_for_reset",
    resetAt: "2026-07-30T15:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    lastRateLimit: detection(),
    ...overrides,
  };
}

describe("computeResetClock", () => {
  it("returns 24 zero-filled buckets for an empty queue", () => {
    const clock = computeResetClock([]);
    expect(clock.hours).toHaveLength(24);
    expect(clock.hours.every((h, i) => h.hour === i && h.count === 0)).toBe(true);
    expect(clock.total).toBe(0);
    expect(clock.unparseable).toBe(0);
    expect(clock.busiestHour).toBeNull();
    expect(clock.busiestCount).toBe(0);
    expect(clock.basis).toBe("detected");
    expect(clock.offsetMinutes).toBe(0);
  });

  it("defaults to bucketing on detectedAt (hour 10 UTC)", () => {
    const clock = computeResetClock([job(), job()]);
    expect(clock.total).toBe(2);
    expect(clock.hours[10].count).toBe(2);
    expect(clock.busiestHour).toBe(10);
    expect(clock.busiestCount).toBe(2);
  });

  it("buckets on resetAt when basis is 'reset' (hour 15 UTC)", () => {
    const clock = computeResetClock([job(), job()], { basis: "reset" });
    expect(clock.basis).toBe("reset");
    expect(clock.hours[15].count).toBe(2);
    expect(clock.hours[10].count).toBe(0);
    expect(clock.busiestHour).toBe(15);
  });

  it("skips jobs with no rate-limit detection (never throttled)", () => {
    const clock = computeResetClock([job(), job({ lastRateLimit: null }), job({ lastRateLimit: undefined })]);
    expect(clock.total).toBe(1);
    expect(clock.hours[10].count).toBe(1);
  });

  it("counts detections whose chosen timestamp is unparseable, without placing them", () => {
    const clock = computeResetClock([job(), job({ lastRateLimit: detection({ detectedAt: "not-a-date" }) })]);
    expect(clock.total).toBe(1);
    expect(clock.unparseable).toBe(1);
    // A basis with a valid field still parses even if the *other* field is junk.
    const byReset = computeResetClock([job({ lastRateLimit: detection({ detectedAt: "nope" }) })], {
      basis: "reset",
    });
    expect(byReset.total).toBe(1);
    expect(byReset.unparseable).toBe(0);
    expect(byReset.hours[15].count).toBe(1);
  });

  it("shifts by offsetMinutes so hours bucket in a local zone", () => {
    // detectedAt 10:00 UTC + 540min (UTC+09:00) → 19:00 local.
    const clock = computeResetClock([job()], { offsetMinutes: 540 });
    expect(clock.offsetMinutes).toBe(540);
    expect(clock.hours[19].count).toBe(1);
    expect(clock.hours[10].count).toBe(0);
  });

  it("wraps across midnight with a negative offset", () => {
    // detectedAt 10:00 UTC - 660min (UTC-11:00) → 23:00 the previous day.
    const clock = computeResetClock([job()], { offsetMinutes: -660 });
    expect(clock.hours[23].count).toBe(1);
  });

  it("picks the earliest hour on a tie for busiestHour", () => {
    const jobs = [
      job({ lastRateLimit: detection({ detectedAt: "2026-07-30T08:30:00.000Z" }) }),
      job({ lastRateLimit: detection({ detectedAt: "2026-07-30T20:15:00.000Z" }) }),
    ];
    const clock = computeResetClock(jobs);
    expect(clock.hours[8].count).toBe(1);
    expect(clock.hours[20].count).toBe(1);
    expect(clock.busiestHour).toBe(8); // tie → earliest
    expect(clock.busiestCount).toBe(1);
  });

  it("aggregates the same hour-of-day across different days", () => {
    const jobs = [
      job({ lastRateLimit: detection({ detectedAt: "2026-07-28T14:00:00.000Z" }) }),
      job({ lastRateLimit: detection({ detectedAt: "2026-07-29T14:45:00.000Z" }) }),
      job({ lastRateLimit: detection({ detectedAt: "2026-07-30T14:59:00.000Z" }) }),
    ];
    const clock = computeResetClock(jobs);
    expect(clock.hours[14].count).toBe(3);
    expect(clock.total).toBe(3);
    expect(clock.busiestHour).toBe(14);
    expect(clock.busiestCount).toBe(3);
  });

  it("exposes exactly the two supported bases", () => {
    expect([...RESET_CLOCK_BASES]).toEqual(["detected", "reset"]);
  });
});
