import { describe, expect, it } from "vitest";
import { normalizeTimeZone, resolveZonedClock } from "../src/timezone.js";

describe("normalizeTimeZone", () => {
  it("returns null for empty / whitespace / nullish input", () => {
    expect(normalizeTimeZone(undefined)).toBeNull();
    expect(normalizeTimeZone(null)).toBeNull();
    expect(normalizeTimeZone("")).toBeNull();
    expect(normalizeTimeZone("   ")).toBeNull();
  });

  it("treats bare UTC / GMT as UTC", () => {
    expect(normalizeTimeZone("UTC")).toBe("UTC");
    expect(normalizeTimeZone("gmt")).toBe("UTC");
    expect(normalizeTimeZone("UTC+0")).toBe("UTC");
    expect(normalizeTimeZone("GMT-00:00")).toBe("UTC");
  });

  it("parses signed UTC/GMT offsets into OFFSET:<minutes>", () => {
    expect(normalizeTimeZone("UTC+9")).toBe("OFFSET:540");
    expect(normalizeTimeZone("GMT-5")).toBe("OFFSET:-300");
    expect(normalizeTimeZone("UTC+05:30")).toBe("OFFSET:330");
    expect(normalizeTimeZone("GMT-0800")).toBe("OFFSET:-480");
  });

  it("rejects out-of-range offsets", () => {
    expect(normalizeTimeZone("UTC+15")).toBeNull();
    expect(normalizeTimeZone("GMT+9:99")).toBeNull();
  });

  it("accepts valid IANA zone ids and rejects bogus ones", () => {
    expect(normalizeTimeZone("America/New_York")).toBe("America/New_York");
    expect(normalizeTimeZone("Asia/Seoul")).toBe("Asia/Seoul");
    expect(normalizeTimeZone("Foo/Bar")).toBeNull();
  });

  it("does not resolve ambiguous abbreviations", () => {
    expect(normalizeTimeZone("PST")).toBeNull();
    expect(normalizeTimeZone("EST")).toBeNull();
  });
});

describe("resolveZonedClock", () => {
  it("resolves a same-day wall time in an IANA zone (EDT, UTC-4)", () => {
    const now = new Date("2026-07-12T08:00:00Z");
    // 5pm New York on 2026-07-12 (EDT) == 21:00 UTC
    const result = resolveZonedClock(now, 17, 0, "America/New_York");
    expect(result?.toISOString()).toBe("2026-07-12T21:00:00.000Z");
  });

  it("resolves a same-day wall time in an IANA zone (EST, UTC-5)", () => {
    const now = new Date("2026-01-12T08:00:00Z");
    // 5pm New York on 2026-01-12 (EST) == 22:00 UTC
    const result = resolveZonedClock(now, 17, 0, "America/New_York");
    expect(result?.toISOString()).toBe("2026-01-12T22:00:00.000Z");
  });

  it("rolls to the next day-in-zone when the wall time is already past", () => {
    // 23:00 UTC — 5pm (21:00 UTC) has already passed, so roll to tomorrow NY.
    const now = new Date("2026-07-12T23:00:00Z");
    const result = resolveZonedClock(now, 17, 0, "America/New_York");
    expect(result?.toISOString()).toBe("2026-07-13T21:00:00.000Z");
  });

  it("resolves a fixed UTC offset", () => {
    const now = new Date("2026-07-11T23:00:00Z"); // just before the reset instant
    // 9am at UTC+9 on 2026-07-12 == 00:00 UTC 2026-07-12.
    const result = resolveZonedClock(now, 9, 0, "OFFSET:540");
    expect(result?.toISOString()).toBe("2026-07-12T00:00:00.000Z");
    expect(result!.getTime()).toBeGreaterThan(now.getTime());
  });

  it("resolves plain UTC wall time", () => {
    const now = new Date("2026-07-12T08:00:00Z");
    const result = resolveZonedClock(now, 17, 30, "UTC");
    expect(result?.toISOString()).toBe("2026-07-12T17:30:00.000Z");
  });

  it("returns null for a malformed zone", () => {
    expect(resolveZonedClock(new Date("2026-07-12T08:00:00Z"), 17, 0, "Foo/Bar")).toBeNull();
    expect(resolveZonedClock(new Date("2026-07-12T08:00:00Z"), 17, 0, "")).toBeNull();
  });
});
