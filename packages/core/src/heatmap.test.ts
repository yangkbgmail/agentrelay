import { describe, expect, it } from "vitest";
import { computeHourlyActivity } from "./heatmap.js";
import type { RelayJob } from "./types.js";

let seq = 0;
function job(createdAt: string, overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "completed",
    resetAt: null,
    createdAt,
    updatedAt: createdAt,
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("computeHourlyActivity", () => {
  it("returns 24 zero-filled buckets for an empty list", () => {
    const activity = computeHourlyActivity([]);
    expect(activity.total).toBe(0);
    expect(activity.counted).toBe(0);
    expect(activity.skipped).toBe(0);
    expect(activity.offsetMinutes).toBe(0);
    expect(activity.hours).toHaveLength(24);
    expect(activity.hours.every((h, i) => h.hour === i && h.count === 0)).toBe(true);
    expect(activity.peakHour).toBeNull();
    expect(activity.peakCount).toBe(0);
  });

  it("buckets jobs by UTC hour of day", () => {
    const activity = computeHourlyActivity([
      job("2026-07-13T09:15:00.000Z"),
      job("2026-07-14T09:59:59.000Z"),
      job("2026-07-15T15:00:00.000Z"),
    ]);
    expect(activity.counted).toBe(3);
    expect(activity.hours[9].count).toBe(2);
    expect(activity.hours[15].count).toBe(1);
    expect(activity.peakHour).toBe(9);
    expect(activity.peakCount).toBe(2);
  });

  it("collapses different days into the same hour bucket", () => {
    const activity = computeHourlyActivity([
      job("2026-01-01T03:00:00.000Z"),
      job("2026-06-15T03:30:00.000Z"),
      job("2026-12-31T03:59:00.000Z"),
    ]);
    expect(activity.hours[3].count).toBe(3);
    expect(activity.counted).toBe(3);
  });

  it("puts midnight and the last hour in the right buckets", () => {
    const activity = computeHourlyActivity([job("2026-07-13T00:00:00.000Z"), job("2026-07-13T23:59:59.999Z")]);
    expect(activity.hours[0].count).toBe(1);
    expect(activity.hours[23].count).toBe(1);
  });

  it("skips jobs with a missing or unparseable createdAt without dropping them from total", () => {
    const activity = computeHourlyActivity([job("2026-07-13T09:00:00.000Z"), job("not-a-date"), job("")]);
    expect(activity.total).toBe(3);
    expect(activity.counted).toBe(1);
    expect(activity.skipped).toBe(2);
    expect(activity.hours[9].count).toBe(1);
  });

  it("shifts buckets by a positive offset (east of UTC)", () => {
    // 22:30 UTC + 9h (Asia/Tokyo, +540) = 07:30 next day → hour 7.
    const activity = computeHourlyActivity([job("2026-07-13T22:30:00.000Z")], { offsetMinutes: 540 });
    expect(activity.offsetMinutes).toBe(540);
    expect(activity.hours[7].count).toBe(1);
    expect(activity.peakHour).toBe(7);
  });

  it("shifts buckets by a negative offset that wraps to the previous day", () => {
    // 02:00 UTC − 7h (US Pacific, -420) = 19:00 previous day → hour 19.
    const activity = computeHourlyActivity([job("2026-07-13T02:00:00.000Z")], { offsetMinutes: -420 });
    expect(activity.hours[19].count).toBe(1);
  });

  it("treats a non-finite offset as UTC (0)", () => {
    const activity = computeHourlyActivity([job("2026-07-13T09:00:00.000Z")], {
      offsetMinutes: Number.NaN,
    });
    expect(activity.offsetMinutes).toBe(0);
    expect(activity.hours[9].count).toBe(1);
  });

  it("breaks a peak tie toward the earliest hour", () => {
    const activity = computeHourlyActivity([
      job("2026-07-13T05:00:00.000Z"),
      job("2026-07-14T05:10:00.000Z"),
      job("2026-07-13T18:00:00.000Z"),
      job("2026-07-14T18:10:00.000Z"),
    ]);
    expect(activity.hours[5].count).toBe(2);
    expect(activity.hours[18].count).toBe(2);
    expect(activity.peakHour).toBe(5);
    expect(activity.peakCount).toBe(2);
  });

  it("does not mutate the input array", () => {
    const jobs = [job("2026-07-13T09:00:00.000Z")];
    const copy = [...jobs];
    computeHourlyActivity(jobs);
    expect(jobs).toEqual(copy);
  });
});
