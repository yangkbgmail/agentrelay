import { describe, expect, it } from "vitest";
import { nextClockTimeInZone, wallTimeInZoneToUtc, zoneOffsetMs } from "../src/timezone.js";

describe("zoneOffsetMs", () => {
  it("returns the summer (DST) offset for America/New_York", () => {
    // 2026-07-01 is EDT = UTC-4.
    expect(zoneOffsetMs("America/New_York", new Date("2026-07-01T12:00:00Z"))).toBe(-4 * 60 * 60_000);
  });

  it("returns the winter (standard) offset for America/New_York", () => {
    // 2026-01-01 is EST = UTC-5.
    expect(zoneOffsetMs("America/New_York", new Date("2026-01-01T12:00:00Z"))).toBe(-5 * 60 * 60_000);
  });

  it("returns a positive offset for a zone east of UTC", () => {
    expect(zoneOffsetMs("Asia/Seoul", new Date("2026-07-01T12:00:00Z"))).toBe(9 * 60 * 60_000);
  });

  it("returns 0 for UTC", () => {
    expect(zoneOffsetMs("UTC", new Date("2026-07-01T12:00:00Z"))).toBe(0);
  });

  it("returns null for an unknown zone", () => {
    expect(zoneOffsetMs("Not/AZone", new Date("2026-07-01T12:00:00Z"))).toBeNull();
  });

  it("returns null for an invalid instant", () => {
    expect(zoneOffsetMs("UTC", new Date("nope"))).toBeNull();
  });
});

describe("wallTimeInZoneToUtc", () => {
  it("converts a summer New York wall time to UTC", () => {
    // 17:00 EDT (UTC-4) == 21:00 UTC.
    const utc = wallTimeInZoneToUtc("America/New_York", 2026, 6, 12, 17, 0);
    expect(utc?.toISOString()).toBe("2026-07-12T21:00:00.000Z");
  });

  it("converts a winter New York wall time to UTC", () => {
    // 17:00 EST (UTC-5) == 22:00 UTC.
    const utc = wallTimeInZoneToUtc("America/New_York", 2026, 0, 12, 17, 0);
    expect(utc?.toISOString()).toBe("2026-01-12T22:00:00.000Z");
  });

  it("converts a Seoul wall time to UTC", () => {
    // 09:00 KST (UTC+9) == 00:00 UTC.
    const utc = wallTimeInZoneToUtc("Asia/Seoul", 2026, 6, 13, 9, 0);
    expect(utc?.toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });

  it("returns null for an unknown zone", () => {
    expect(wallTimeInZoneToUtc("Not/AZone", 2026, 6, 12, 17, 0)).toBeNull();
  });
});

describe("nextClockTimeInZone", () => {
  it("resolves today's occurrence when it is still ahead in the zone", () => {
    // 08:00 UTC; 5pm New York (21:00 UTC) is later today.
    const now = new Date("2026-07-12T08:00:00Z");
    expect(nextClockTimeInZone(now, 17, 0, "America/New_York")?.toISOString()).toBe("2026-07-12T21:00:00.000Z");
  });

  it("rolls to tomorrow in the zone when today's occurrence is past", () => {
    // 03:00 UTC == 12:00 KST already past 09:00 KST -> next is 2026-07-13 09:00 KST (00:00 UTC).
    const now = new Date("2026-07-12T03:00:00Z");
    expect(nextClockTimeInZone(now, 9, 0, "Asia/Seoul")?.toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });

  it("rolls across a month boundary in the zone", () => {
    // 2026-07-31 23:30 UTC == 2026-08-01 08:30 KST; asking for 08:00 KST is already
    // past today (Aug 1), so it rolls to 08:00 KST Aug 2 == 2026-08-01 23:00 UTC.
    const now = new Date("2026-07-31T23:30:00Z");
    expect(nextClockTimeInZone(now, 8, 0, "Asia/Seoul")?.toISOString()).toBe("2026-08-01T23:00:00.000Z");
  });

  it("returns null for an unknown zone", () => {
    expect(nextClockTimeInZone(new Date("2026-07-12T08:00:00Z"), 17, 0, "Not/AZone")).toBeNull();
  });
});
