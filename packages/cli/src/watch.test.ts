import { describe, expect, it } from "vitest";
import { DEFAULT_WATCH_SECONDS, parseWatchInterval, renderWatchHeader } from "./watch.js";

describe("parseWatchInterval", () => {
  it("honours an explicit positive number of seconds (rounded to ms)", () => {
    expect(parseWatchInterval("5")).toBe(5000);
    expect(parseWatchInterval("1.5")).toBe(1500);
    expect(parseWatchInterval("0.25")).toBe(250);
  });

  it("falls back to the default for the bare flag (true)", () => {
    expect(parseWatchInterval(true)).toBe(DEFAULT_WATCH_SECONDS * 1000);
  });

  it("falls back to the default for undefined", () => {
    expect(parseWatchInterval(undefined)).toBe(DEFAULT_WATCH_SECONDS * 1000);
  });

  it("falls back to the default for non-numbers, zero, and negatives", () => {
    expect(parseWatchInterval("abc")).toBe(DEFAULT_WATCH_SECONDS * 1000);
    expect(parseWatchInterval("0")).toBe(DEFAULT_WATCH_SECONDS * 1000);
    expect(parseWatchInterval("-3")).toBe(DEFAULT_WATCH_SECONDS * 1000);
  });

  it("accepts a caller-supplied default", () => {
    expect(parseWatchInterval(true, 10)).toBe(10000);
    expect(parseWatchInterval("bad", 10)).toBe(10000);
  });
});

describe("renderWatchHeader", () => {
  const now = Date.UTC(2026, 7, 2, 12, 34, 56); // 2026-08-02 12:34:56 UTC

  it("renders a plain two-line banner with command, cadence, timestamp, and store", () => {
    const header = renderWatchHeader("upcoming", "/tmp/jobs.json", 2000, now, false);
    const [title, meta] = header.split("\n");
    expect(title).toBe("agentrelay upcoming (live, every 2s — Ctrl-C to exit)");
    expect(meta).toBe("2026-08-02 12:34:56Z · /tmp/jobs.json");
  });

  it("rounds the interval to whole seconds", () => {
    const header = renderWatchHeader("overdue", "/s.json", 1500, now, false);
    expect(header).toContain("every 2s");
  });

  it("wraps the title in ANSI codes when color is on", () => {
    const header = renderWatchHeader("tools", "/s.json", 3000, now, true);
    expect(header).toContain("\x1b[1m");
    expect(header).toContain("\x1b[2m");
    expect(header).toContain("\x1b[0m");
  });
});
