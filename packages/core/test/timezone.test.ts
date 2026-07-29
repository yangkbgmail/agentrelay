import { describe, expect, it } from "vitest";
import { nextZonedInstant, tzOffsetMsAt, zonedWallClockToUtc } from "../src/timezone.js";

const HOUR = 60 * 60_000;

describe("tzOffsetMsAt", () => {
  it("is zero for UTC", () => {
    expect(tzOffsetMsAt(Date.parse("2026-07-12T00:00:00Z"), "UTC")).toBe(0);
  });

  it("is +9h for Asia/Seoul (no DST)", () => {
    expect(tzOffsetMsAt(Date.parse("2026-07-12T00:00:00Z"), "Asia/Seoul")).toBe(9 * HOUR);
    // Winter — same, Seoul has no daylight saving.
    expect(tzOffsetMsAt(Date.parse("2026-01-12T00:00:00Z"), "Asia/Seoul")).toBe(9 * HOUR);
  });

  it("tracks DST for America/New_York (EDT in July, EST in January)", () => {
    expect(tzOffsetMsAt(Date.parse("2026-07-12T12:00:00Z"), "America/New_York")).toBe(-4 * HOUR);
    expect(tzOffsetMsAt(Date.parse("2026-01-12T12:00:00Z"), "America/New_York")).toBe(-5 * HOUR);
  });

  it("returns null for an unrecognized zone", () => {
    expect(tzOffsetMsAt(Date.parse("2026-07-12T00:00:00Z"), "Mars/Olympus")).toBeNull();
  });
});

describe("zonedWallClockToUtc", () => {
  it("converts a Seoul wall clock to the right UTC instant", () => {
    // 15:00 KST == 06:00 UTC.
    const ms = zonedWallClockToUtc(2026, 7, 12, 15, 0, "Asia/Seoul");
    expect(new Date(ms!).toISOString()).toBe("2026-07-12T06:00:00.000Z");
  });

  it("converts a New York summer wall clock (EDT) to UTC", () => {
    // 17:00 EDT == 21:00 UTC.
    const ms = zonedWallClockToUtc(2026, 7, 12, 17, 0, "America/New_York");
    expect(new Date(ms!).toISOString()).toBe("2026-07-12T21:00:00.000Z");
  });

  it("converts a New York winter wall clock (EST) to UTC", () => {
    // 17:00 EST == 22:00 UTC.
    const ms = zonedWallClockToUtc(2026, 1, 12, 17, 0, "America/New_York");
    expect(new Date(ms!).toISOString()).toBe("2026-01-12T22:00:00.000Z");
  });

  it("round-trips through tzOffsetMsAt for a range of zones", () => {
    for (const tz of ["UTC", "Asia/Seoul", "America/New_York", "Europe/London", "Australia/Sydney"]) {
      const ms = zonedWallClockToUtc(2026, 6, 15, 9, 30, tz)!;
      // Reading the instant back in the zone must show 09:30.
      const offset = tzOffsetMsAt(ms, tz)!;
      const wall = new Date(ms + offset);
      expect(wall.getUTCHours()).toBe(9);
      expect(wall.getUTCMinutes()).toBe(30);
    }
  });

  it("returns null for an unrecognized zone", () => {
    expect(zonedWallClockToUtc(2026, 7, 12, 15, 0, "Nowhere/Land")).toBeNull();
  });
});

describe("nextZonedInstant", () => {
  it("returns today's instant when it is still in the future", () => {
    const now = new Date("2026-07-12T00:00:00Z"); // 09:00 KST
    const d = nextZonedInstant(now, 15, 0, "Asia/Seoul"); // 15:00 KST == 06:00 UTC today
    expect(d?.toISOString()).toBe("2026-07-12T06:00:00.000Z");
  });

  it("rolls to tomorrow when today's zoned instant has already passed", () => {
    const now = new Date("2026-07-12T20:00:00Z"); // 05:00 KST the 13th already
    // 15:00 KST on the 13th == 06:00 UTC on the 13th.
    const d = nextZonedInstant(now, 15, 0, "Asia/Seoul");
    expect(d?.toISOString()).toBe("2026-07-13T06:00:00.000Z");
  });

  it("crosses a month boundary correctly when rolling to tomorrow", () => {
    // 2026-07-31 23:00 UTC == 2026-08-01 08:00 KST already; 07:00 KST target has passed.
    const now = new Date("2026-07-31T23:00:00Z");
    const d = nextZonedInstant(now, 7, 0, "Asia/Seoul"); // 07:00 KST
    // Next 07:00 KST is 2026-08-02 07:00 KST? No — 08-01 07:00 KST == 07-31 22:00 UTC (past),
    // so next is 08-02 07:00 KST == 08-01 22:00 UTC.
    expect(d?.toISOString()).toBe("2026-08-01T22:00:00.000Z");
  });

  it("always returns a future instant", () => {
    const now = new Date("2026-03-15T12:34:56Z");
    for (const tz of ["UTC", "Asia/Seoul", "America/New_York", "Europe/Paris"]) {
      for (let hour = 0; hour < 24; hour += 3) {
        const d = nextZonedInstant(now, hour, 0, tz)!;
        expect(d.getTime()).toBeGreaterThan(now.getTime());
      }
    }
  });

  it("returns null for an unrecognized zone", () => {
    expect(nextZonedInstant(new Date("2026-07-12T00:00:00Z"), 15, 0, "Bad/Zone")).toBeNull();
  });
});
