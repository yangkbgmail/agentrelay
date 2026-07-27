import { describe, expect, it } from "vitest";
import { nextZonedClockTime, normalizeZone } from "../src/tz.js";

describe("normalizeZone", () => {
  it("maps UTC/GMT (any case) to UTC", () => {
    expect(normalizeZone("UTC")).toBe("UTC");
    expect(normalizeZone("gmt")).toBe("UTC");
    expect(normalizeZone("  Utc ")).toBe("UTC");
  });

  it("passes through IANA zone names (which contain a slash)", () => {
    expect(normalizeZone("America/New_York")).toBe("America/New_York");
    expect(normalizeZone("Asia/Seoul")).toBe("Asia/Seoul");
  });

  it("rejects ambiguous abbreviations and junk", () => {
    expect(normalizeZone("PST")).toBeNull();
    expect(normalizeZone("EST")).toBeNull();
    expect(normalizeZone("banana")).toBeNull();
    expect(normalizeZone("")).toBeNull();
  });
});

describe("nextZonedClockTime", () => {
  it("resolves an afternoon time later today in a UTC+9 zone", () => {
    const now = new Date("2026-07-27T05:00:00Z"); // 14:00 Seoul
    // 15:30 Seoul = 06:30 UTC, still ahead of now
    const r = nextZonedClockTime(now, 15, 30, "Asia/Seoul");
    expect(r?.toISOString()).toBe("2026-07-27T06:30:00.000Z");
  });

  it("rolls to tomorrow in the zone when the time already passed", () => {
    const now = new Date("2026-07-27T22:00:00Z");
    // 5pm New York (EDT) = 21:00 UTC, already past → next day
    const r = nextZonedClockTime(now, 17, 0, "America/New_York");
    expect(r?.toISOString()).toBe("2026-07-28T21:00:00.000Z");
  });

  it("handles the New York winter offset (EST, UTC-5)", () => {
    const now = new Date("2026-01-15T12:00:00Z");
    // 9am New York in January = EST = 14:00 UTC, still ahead of now (12:00Z)
    const r = nextZonedClockTime(now, 9, 0, "America/New_York");
    expect(r?.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("crosses a month/year boundary correctly when rolling to the next day", () => {
    // 23:00 UTC Dec 31; 1am UTC already passed today → Jan 1 next year
    const now = new Date("2026-12-31T23:00:00Z");
    const r = nextZonedClockTime(now, 1, 0, "UTC");
    expect(r?.toISOString()).toBe("2027-01-01T01:00:00.000Z");
  });

  it("returns null for an unrecognized zone so the caller can fall back", () => {
    expect(nextZonedClockTime(new Date("2026-07-27T05:00:00Z"), 9, 0, "PST")).toBeNull();
    expect(nextZonedClockTime(new Date("2026-07-27T05:00:00Z"), 9, 0, "Not/AZone")).toBeNull();
  });
});
