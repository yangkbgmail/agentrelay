import { describe, expect, it } from "vitest";
import { isNamedTimeZone, isValidTimeZone, nextWallClockInZone, timeZoneOffsetMs } from "../src/timezone.js";

describe("isValidTimeZone", () => {
  it("accepts real IANA zones and UTC", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Asia/Seoul")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects unknown tokens and empty input", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("soon")).toBe(false);
  });
});

describe("isNamedTimeZone", () => {
  it("accepts unambiguous IANA Area/Location names and UTC/GMT", () => {
    expect(isNamedTimeZone("America/New_York")).toBe(true);
    expect(isNamedTimeZone("Asia/Seoul")).toBe(true);
    expect(isNamedTimeZone("  UTC ")).toBe(true);
    expect(isNamedTimeZone("gmt")).toBe(true);
  });

  it("rejects bare abbreviations even when the runtime maps them (PST/EST are ambiguous)", () => {
    expect(isNamedTimeZone("PST")).toBe(false);
    expect(isNamedTimeZone("EST")).toBe(false);
    expect(isNamedTimeZone("Japan")).toBe(false); // single-word zones are not trusted here
    expect(isNamedTimeZone("")).toBe(false);
    expect(isNamedTimeZone("Not/AZone")).toBe(false); // slash form but not a real zone
  });
});

describe("timeZoneOffsetMs", () => {
  const H = 60 * 60 * 1000;

  it("returns +9h for Asia/Seoul (no DST)", () => {
    expect(timeZoneOffsetMs("Asia/Seoul", new Date("2026-07-12T00:00:00Z"))).toBe(9 * H);
    expect(timeZoneOffsetMs("Asia/Seoul", new Date("2026-01-12T00:00:00Z"))).toBe(9 * H);
  });

  it("tracks DST for America/New_York (EDT in summer, EST in winter)", () => {
    expect(timeZoneOffsetMs("America/New_York", new Date("2026-07-12T12:00:00Z"))).toBe(-4 * H); // EDT
    expect(timeZoneOffsetMs("America/New_York", new Date("2026-01-12T12:00:00Z"))).toBe(-5 * H); // EST
  });

  it("returns 0 for UTC and null for invalid zones", () => {
    expect(timeZoneOffsetMs("UTC", new Date("2026-07-12T00:00:00Z"))).toBe(0);
    expect(timeZoneOffsetMs("Not/AZone", new Date())).toBeNull();
  });
});

describe("nextWallClockInZone", () => {
  it("resolves a future wall clock on the same zone-day", () => {
    // 09:00 KST -> next 3pm KST is today 3pm == 06:00 UTC.
    const now = new Date("2026-07-12T00:00:00Z");
    const result = nextWallClockInZone(now, 15, 0, "Asia/Seoul");
    expect(result?.toISOString()).toBe("2026-07-12T06:00:00.000Z");
  });

  it("rolls to the next zone-day when the wall clock is already past", () => {
    // 19:00 KST is past 3pm, so next 3pm KST is tomorrow == next-day 06:00 UTC.
    const now = new Date("2026-07-12T10:00:00Z");
    const result = nextWallClockInZone(now, 15, 0, "Asia/Seoul");
    expect(result?.toISOString()).toBe("2026-07-13T06:00:00.000Z");
  });

  it("crosses a month boundary correctly", () => {
    // 23:30 KST on the last day of the month, target 01:00 KST -> next day (new month).
    const now = new Date("2026-07-31T14:30:00Z"); // 23:30 KST Jul 31
    const result = nextWallClockInZone(now, 1, 0, "Asia/Seoul");
    expect(result?.toISOString()).toBe("2026-07-31T16:00:00.000Z"); // 01:00 KST Aug 1
  });

  it("honors DST offset for America/New_York", () => {
    // 5pm EDT (July) == 21:00 UTC.
    const now = new Date("2026-07-12T08:00:00Z");
    const result = nextWallClockInZone(now, 17, 0, "America/New_York");
    expect(result?.toISOString()).toBe("2026-07-12T21:00:00.000Z");
    // 5pm EST (January) == 22:00 UTC.
    const winter = new Date("2026-01-12T08:00:00Z");
    const winterResult = nextWallClockInZone(winter, 17, 0, "America/New_York");
    expect(winterResult?.toISOString()).toBe("2026-01-12T22:00:00.000Z");
  });

  it("returns null for an invalid zone so callers can fall back to local", () => {
    expect(nextWallClockInZone(new Date(), 17, 0, "Not/AZone")).toBeNull();
  });
});
