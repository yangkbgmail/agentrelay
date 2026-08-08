import { describe, expect, it } from "vitest";
import { formatUtcOffsetLabel, parseUtcOffsetMinutes } from "./tz.js";

describe("parseUtcOffsetMinutes", () => {
  it("treats UTC/GMT/Z (any case) as zero", () => {
    for (const input of ["UTC", "utc", "GMT", "gmt", "Z", "z", " UTC "]) {
      expect(parseUtcOffsetMinutes(input)).toBe(0);
    }
  });

  it("parses whole-hour offsets with and without a sign", () => {
    expect(parseUtcOffsetMinutes("+9")).toBe(540);
    expect(parseUtcOffsetMinutes("9")).toBe(540);
    expect(parseUtcOffsetMinutes("-5")).toBe(-300);
    expect(parseUtcOffsetMinutes("+09")).toBe(540);
  });

  it("parses HH:MM and HHMM forms, including half/quarter-hour zones", () => {
    expect(parseUtcOffsetMinutes("+09:00")).toBe(540);
    expect(parseUtcOffsetMinutes("+0900")).toBe(540);
    expect(parseUtcOffsetMinutes("+05:30")).toBe(330);
    expect(parseUtcOffsetMinutes("-05:30")).toBe(-330);
    expect(parseUtcOffsetMinutes("+05:45")).toBe(345);
  });

  it("accepts an optional UTC/GMT prefix on an offset", () => {
    expect(parseUtcOffsetMinutes("UTC+9")).toBe(540);
    expect(parseUtcOffsetMinutes("GMT-05:00")).toBe(-300);
    expect(parseUtcOffsetMinutes("utc+05:30")).toBe(330);
  });

  it("clamps to the ±14:00 real-world range", () => {
    expect(parseUtcOffsetMinutes("+14:00")).toBe(840);
    expect(parseUtcOffsetMinutes("-14:00")).toBe(-840);
    expect(parseUtcOffsetMinutes("+14:30")).toBeNull();
    expect(parseUtcOffsetMinutes("+15")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    for (const input of ["", "  ", "abc", "+", "+9:99", "9h", "local", "++9", "+1:2"]) {
      expect(parseUtcOffsetMinutes(input)).toBeNull();
    }
  });
});

describe("formatUtcOffsetLabel", () => {
  it("labels zero as UTC", () => {
    expect(formatUtcOffsetLabel(0)).toBe("UTC");
  });

  it("formats signed HH:MM labels", () => {
    expect(formatUtcOffsetLabel(540)).toBe("UTC+09:00");
    expect(formatUtcOffsetLabel(-300)).toBe("UTC-05:00");
    expect(formatUtcOffsetLabel(330)).toBe("UTC+05:30");
    expect(formatUtcOffsetLabel(-330)).toBe("UTC-05:30");
    expect(formatUtcOffsetLabel(345)).toBe("UTC+05:45");
  });

  it("round-trips with parseUtcOffsetMinutes for canonical offsets", () => {
    for (const min of [0, 540, -300, 330, -330, 840, -840]) {
      const label = formatUtcOffsetLabel(min);
      expect(parseUtcOffsetMinutes(label)).toBe(min);
    }
  });
});
