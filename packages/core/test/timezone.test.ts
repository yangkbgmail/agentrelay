import { describe, expect, it } from "vitest";
import { isIanaZone, parseFixedOffsetMinutes, resolveZonedClockTime } from "../src/timezone.js";

describe("parseFixedOffsetMinutes", () => {
  it("treats bare UTC / GMT as offset 0", () => {
    expect(parseFixedOffsetMinutes("UTC")).toBe(0);
    expect(parseFixedOffsetMinutes("gmt")).toBe(0);
  });

  it("parses signed hour offsets", () => {
    expect(parseFixedOffsetMinutes("UTC+2")).toBe(120);
    expect(parseFixedOffsetMinutes("GMT-8")).toBe(-480);
  });

  it("parses hour:minute offsets with or without a colon", () => {
    expect(parseFixedOffsetMinutes("UTC+05:30")).toBe(330);
    expect(parseFixedOffsetMinutes("UTC+0530")).toBe(330);
    expect(parseFixedOffsetMinutes("GMT-0330")).toBe(-210);
  });

  it("returns null for non-UTC/GMT tokens and out-of-range offsets", () => {
    expect(parseFixedOffsetMinutes("America/New_York")).toBeNull();
    expect(parseFixedOffsetMinutes("PST")).toBeNull();
    expect(parseFixedOffsetMinutes("UTC+20")).toBeNull(); // beyond ±14:00
  });
});

describe("isIanaZone", () => {
  it("accepts real IANA names", () => {
    expect(isIanaZone("America/New_York")).toBe(true);
    expect(isIanaZone("Europe/Paris")).toBe(true);
  });

  it("rejects abbreviations, bare words, and garbage", () => {
    expect(isIanaZone("PST")).toBe(false);
    expect(isIanaZone("America")).toBe(false);
    expect(isIanaZone("Not/AZone")).toBe(false);
  });
});

describe("resolveZonedClockTime", () => {
  it("resolves an IANA wall clock to the correct UTC instant (summer DST)", () => {
    const now = new Date("2026-07-12T08:00:00Z");
    const d = resolveZonedClockTime(17, 0, now, "America/New_York"); // EDT (UTC-4)
    expect(d?.toISOString()).toBe("2026-07-12T21:00:00.000Z");
  });

  it("resolves an IANA wall clock across a DST boundary (winter)", () => {
    const now = new Date("2026-01-12T08:00:00Z");
    const d = resolveZonedClockTime(17, 0, now, "America/New_York"); // EST (UTC-5)
    expect(d?.toISOString()).toBe("2026-01-12T22:00:00.000Z");
  });

  it("strips surrounding parentheses from the token", () => {
    const now = new Date("2026-07-12T06:00:00Z");
    const d = resolveZonedClockTime(15, 30, now, "(Europe/Paris)"); // CEST (UTC+2)
    expect(d?.toISOString()).toBe("2026-07-12T13:30:00.000Z");
  });

  it("rolls to the next day when the slot is already past", () => {
    const now = new Date("2026-07-12T20:00:00Z");
    const d = resolveZonedClockTime(9, 0, now, "UTC");
    expect(d?.toISOString()).toBe("2026-07-13T09:00:00.000Z");
  });

  it("resolves a fixed UTC offset", () => {
    const now = new Date("2026-07-12T06:00:00Z");
    const d = resolveZonedClockTime(18, 0, now, "UTC+05:30");
    expect(d?.toISOString()).toBe("2026-07-12T12:30:00.000Z");
  });

  it("returns null for an unresolvable zone token so the caller can fall back", () => {
    const now = new Date("2026-07-12T06:00:00Z");
    expect(resolveZonedClockTime(17, 0, now, "PST")).toBeNull();
    expect(resolveZonedClockTime(17, 0, now, "")).toBeNull();
  });
});
