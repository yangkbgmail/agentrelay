import { describe, expect, it } from "vitest";
import { parseZoneToken, resolveZonedClockTime } from "../src/tz.js";

describe("parseZoneToken", () => {
  it("maps Z/UTC/GMT (any case) to a zero offset", () => {
    for (const token of ["Z", "z", "UTC", "utc", "GMT", "gmt"]) {
      expect(parseZoneToken(token)).toEqual({ kind: "offset", offsetMs: 0 });
    }
  });

  it("parses signed HH:MM and HHMM offsets", () => {
    expect(parseZoneToken("+09:00")).toEqual({ kind: "offset", offsetMs: 9 * 3_600_000 });
    expect(parseZoneToken("-0500")).toEqual({ kind: "offset", offsetMs: -5 * 3_600_000 });
    expect(parseZoneToken("+05:30")).toEqual({ kind: "offset", offsetMs: (5 * 60 + 30) * 60_000 });
    expect(parseZoneToken("+9")).toEqual({ kind: "offset", offsetMs: 9 * 3_600_000 });
  });

  it("rejects out-of-range offsets", () => {
    expect(parseZoneToken("+15:00")).toBeNull(); // beyond +14
    expect(parseZoneToken("-05:99")).toBeNull(); // bad minutes
  });

  it("accepts valid IANA names and rejects bogus ones", () => {
    expect(parseZoneToken("America/New_York")).toEqual({ kind: "iana", timeZone: "America/New_York" });
    expect(parseZoneToken("Asia/Tokyo")).toEqual({ kind: "iana", timeZone: "Asia/Tokyo" });
    expect(parseZoneToken("America/Argentina/Buenos_Aires")).toEqual({
      kind: "iana",
      timeZone: "America/Argentina/Buenos_Aires",
    });
    expect(parseZoneToken("Mars/Olympus_Mons")).toBeNull();
  });

  it("rejects ambiguous letter abbreviations and empty tokens", () => {
    expect(parseZoneToken("ET")).toBeNull();
    expect(parseZoneToken("PST")).toBeNull();
    expect(parseZoneToken("")).toBeNull();
    expect(parseZoneToken("   ")).toBeNull();
  });
});

describe("resolveZonedClockTime", () => {
  it("resolves a fixed offset to the correct UTC instant, rolling forward when past", () => {
    const now = new Date("2026-07-12T08:00:00Z");
    // 15:00 at +09:00 is 06:00 UTC; already past 08:00 now -> next day.
    const zone = parseZoneToken("+09:00")!;
    expect(resolveZonedClockTime(15, 0, zone, now)?.toISOString()).toBe("2026-07-13T06:00:00.000Z");
  });

  it("keeps a fixed-offset time on the same day when still future", () => {
    const now = new Date("2026-07-12T02:00:00Z");
    const zone = parseZoneToken("+09:00")!;
    expect(resolveZonedClockTime(15, 0, zone, now)?.toISOString()).toBe("2026-07-12T06:00:00.000Z");
  });

  it("resolves a named zone honoring DST (EDT vs EST)", () => {
    const summer = new Date("2026-07-12T08:00:00Z");
    const winter = new Date("2026-01-12T08:00:00Z");
    const ny = parseZoneToken("America/New_York")!;
    expect(resolveZonedClockTime(17, 0, ny, summer)?.toISOString()).toBe("2026-07-12T21:00:00.000Z");
    expect(resolveZonedClockTime(17, 0, ny, winter)?.toISOString()).toBe("2026-01-12T22:00:00.000Z");
  });

  it("returns the next future occurrence, never one at-or-before now", () => {
    const now = new Date("2026-07-12T21:00:00Z");
    const ny = parseZoneToken("America/New_York")!;
    // 17:00 ET today == 21:00 UTC == now exactly -> must roll to tomorrow.
    const result = resolveZonedClockTime(17, 0, ny, now);
    expect(result?.toISOString()).toBe("2026-07-13T21:00:00.000Z");
    expect(result!.getTime()).toBeGreaterThan(now.getTime());
  });
});
