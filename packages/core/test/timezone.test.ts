import { describe, expect, it } from "vitest";
import {
  ianaOffsetMinutes,
  isValidIanaZone,
  nextClockTimeInZone,
  type ParsedZone,
  parseZoneToken,
} from "../src/timezone.js";

describe("parseZoneToken", () => {
  it("parses bare UTC/GMT/Z as a zero offset", () => {
    for (const t of ["UTC", "gmt", "Z", " utc "]) {
      expect(parseZoneToken(t)).toEqual({ kind: "offset", offsetMinutes: 0 });
    }
  });

  it("parses UTC/GMT prefixed offsets", () => {
    expect(parseZoneToken("UTC+9")).toEqual({ kind: "offset", offsetMinutes: 540 });
    expect(parseZoneToken("GMT-5")).toEqual({ kind: "offset", offsetMinutes: -300 });
    expect(parseZoneToken("UTC+05:30")).toEqual({ kind: "offset", offsetMinutes: 330 });
    expect(parseZoneToken("gmt-0800")).toEqual({ kind: "offset", offsetMinutes: -480 });
  });

  it("parses a bare signed offset", () => {
    expect(parseZoneToken("+09:00")).toEqual({ kind: "offset", offsetMinutes: 540 });
    expect(parseZoneToken("-8")).toEqual({ kind: "offset", offsetMinutes: -480 });
  });

  it("recognizes IANA zone names", () => {
    expect(parseZoneToken("America/New_York")).toEqual({ kind: "iana", name: "America/New_York" });
    expect(parseZoneToken("Asia/Seoul")).toEqual({ kind: "iana", name: "Asia/Seoul" });
  });

  it("returns null for junk, empty, and out-of-range offsets", () => {
    expect(parseZoneToken("")).toBeNull();
    expect(parseZoneToken("   ")).toBeNull();
    expect(parseZoneToken("Narnia/Cair_Paravel")).toBeNull();
    expect(parseZoneToken("soon")).toBeNull();
    expect(parseZoneToken("UTC+99")).toBeNull(); // hours > 14
    expect(parseZoneToken("+05:75")).toBeNull(); // minutes > 59
  });
});

describe("isValidIanaZone", () => {
  it("accepts real zones and rejects fake ones", () => {
    expect(isValidIanaZone("Europe/London")).toBe(true);
    expect(isValidIanaZone("Asia/Seoul")).toBe(true);
    expect(isValidIanaZone("Middle/Earth")).toBe(false);
    expect(isValidIanaZone("")).toBe(false);
  });
});

describe("ianaOffsetMinutes", () => {
  it("resolves DST-aware offsets for America/New_York", () => {
    // July -> EDT (UTC-4); January -> EST (UTC-5).
    expect(ianaOffsetMinutes("America/New_York", new Date("2026-07-01T12:00:00Z"))).toBe(-240);
    expect(ianaOffsetMinutes("America/New_York", new Date("2026-01-01T12:00:00Z"))).toBe(-300);
  });

  it("resolves a fixed +9 zone with no DST", () => {
    expect(ianaOffsetMinutes("Asia/Seoul", new Date("2026-07-01T12:00:00Z"))).toBe(540);
    expect(ianaOffsetMinutes("Asia/Seoul", new Date("2026-01-01T12:00:00Z"))).toBe(540);
  });

  it("returns null for an unknown zone", () => {
    expect(ianaOffsetMinutes("Middle/Earth", new Date("2026-07-01T12:00:00Z"))).toBeNull();
  });
});

describe("nextClockTimeInZone", () => {
  const seoul: ParsedZone = { kind: "iana", name: "Asia/Seoul" };
  const ny: ParsedZone = { kind: "iana", name: "America/New_York" };
  const plus9: ParsedZone = { kind: "offset", offsetMinutes: 540 };

  it("returns today's time in the zone when it is still ahead", () => {
    const now = new Date("2026-07-12T06:00:00Z"); // 15:00 Seoul
    // 17:00 Seoul today == 08:00 UTC, still ahead of now.
    expect(nextClockTimeInZone(seoul, 17, 0, now)?.toISOString()).toBe("2026-07-12T08:00:00.000Z");
  });

  it("rolls to the next zone-day when today's time has passed", () => {
    const now = new Date("2026-07-12T08:00:00Z"); // 17:00 Seoul
    // 9am Seoul today already passed (00:00 UTC), so roll to next day.
    expect(nextClockTimeInZone(seoul, 9, 0, now)?.toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });

  it("matches the fixed-offset and IANA paths for a no-DST zone", () => {
    const now = new Date("2026-07-12T06:00:00Z");
    const viaIana = nextClockTimeInZone(seoul, 17, 0, now);
    const viaOffset = nextClockTimeInZone(plus9, 17, 0, now);
    expect(viaOffset?.toISOString()).toBe(viaIana?.toISOString());
  });

  it("computes a DST-correct instant for America/New_York in summer", () => {
    const now = new Date("2026-07-12T08:00:00Z"); // 04:00 EDT
    // 5pm EDT (UTC-4) == 21:00 UTC.
    expect(nextClockTimeInZone(ny, 17, 0, now)?.toISOString()).toBe("2026-07-12T21:00:00.000Z");
  });

  it("computes a DST-correct instant for America/New_York in winter", () => {
    const now = new Date("2026-01-12T08:00:00Z"); // 03:00 EST
    // 5pm EST (UTC-5) == 22:00 UTC.
    expect(nextClockTimeInZone(ny, 17, 0, now)?.toISOString()).toBe("2026-01-12T22:00:00.000Z");
  });

  it("returns null for an unresolvable zone", () => {
    const bogus: ParsedZone = { kind: "iana", name: "Middle/Earth" };
    expect(nextClockTimeInZone(bogus, 17, 0, new Date("2026-07-12T08:00:00Z"))).toBeNull();
  });
});
