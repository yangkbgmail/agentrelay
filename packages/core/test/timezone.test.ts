import { describe, expect, it } from "vitest";
import {
  isValidTimeZone,
  normalizeTimeZone,
  timeZoneOffsetMs,
  zoneCalendarDate,
  zonedWallClockToUtc,
} from "../src/timezone.js";

describe("isValidTimeZone", () => {
  it("accepts IANA identifiers and UTC", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects garbage and empties without throwing", () => {
    // Raw Intl probe: clearly-invalid names and the empty string are false.
    // (Some ICU builds tolerate a few civil abbreviations like "PST"; the
    // abbreviation *policy* lives in normalizeTimeZone, tested below.)
    expect(isValidTimeZone("Not/A_Zone_At_All")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("   ")).toBe(false);
  });
});

describe("normalizeTimeZone", () => {
  it("passes through valid IANA names and UTC/GMT", () => {
    expect(normalizeTimeZone("America/New_York")).toBe("America/New_York");
    expect(normalizeTimeZone("  Europe/London  ")).toBe("Europe/London");
    expect(normalizeTimeZone("utc")).toBe("UTC");
    expect(normalizeTimeZone("GMT")).toBe("GMT");
  });

  it("maps Z / Zulu to UTC", () => {
    expect(normalizeTimeZone("Z")).toBe("UTC");
    expect(normalizeTimeZone("zulu")).toBe("UTC");
  });

  it("rejects ambiguous abbreviations and empties as null", () => {
    expect(normalizeTimeZone("PST")).toBeNull();
    expect(normalizeTimeZone("IST")).toBeNull();
    expect(normalizeTimeZone("")).toBeNull();
    expect(normalizeTimeZone(undefined)).toBeNull();
    expect(normalizeTimeZone(null)).toBeNull();
  });
});

describe("timeZoneOffsetMs", () => {
  it("computes fixed offsets", () => {
    const instant = new Date("2026-06-01T00:00:00Z");
    expect(timeZoneOffsetMs("UTC", instant)).toBe(0);
    // Tokyo is UTC+9 year-round.
    expect(timeZoneOffsetMs("Asia/Tokyo", instant)).toBe(9 * 60 * 60_000);
  });

  it("accounts for DST (New York summer vs winter)", () => {
    const summer = new Date("2026-07-01T12:00:00Z"); // EDT, UTC-4
    const winter = new Date("2026-01-01T12:00:00Z"); // EST, UTC-5
    expect(timeZoneOffsetMs("America/New_York", summer)).toBe(-4 * 60 * 60_000);
    expect(timeZoneOffsetMs("America/New_York", winter)).toBe(-5 * 60 * 60_000);
  });
});

describe("zoneCalendarDate", () => {
  it("reports the local calendar date across the UTC boundary", () => {
    // 23:00 UTC is already the next day in Tokyo (08:00).
    const instant = new Date("2026-05-20T23:00:00Z");
    expect(zoneCalendarDate(instant, "Asia/Tokyo")).toEqual({ year: 2026, month: 5, day: 21 });
    expect(zoneCalendarDate(instant, "UTC")).toEqual({ year: 2026, month: 5, day: 20 });
  });
});

describe("zonedWallClockToUtc", () => {
  it("resolves a wall clock in a fixed-offset zone", () => {
    const d = zonedWallClockToUtc({ year: 2026, month: 5, day: 21, hour: 9, minute: 0 }, "Asia/Tokyo");
    expect(d.toISOString()).toBe("2026-05-21T00:00:00.000Z"); // 9am JST = 00:00 UTC
  });

  it("resolves a wall clock across a DST boundary (summer EDT)", () => {
    const d = zonedWallClockToUtc({ year: 2026, month: 7, day: 12, hour: 17, minute: 0 }, "America/New_York");
    expect(d.toISOString()).toBe("2026-07-12T21:00:00.000Z"); // 5pm EDT = 21:00 UTC
  });

  it("resolves a wall clock in winter (EST)", () => {
    const d = zonedWallClockToUtc({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, "America/New_York");
    expect(d.toISOString()).toBe("2026-01-15T14:00:00.000Z"); // 9am EST = 14:00 UTC
  });

  it("is stable for UTC input", () => {
    const d = zonedWallClockToUtc({ year: 2026, month: 3, day: 10, hour: 15, minute: 30 }, "UTC");
    expect(d.toISOString()).toBe("2026-03-10T15:30:00.000Z");
  });
});
