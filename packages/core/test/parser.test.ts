import { describe, expect, it } from "vitest";
import { parseRateLimitMessage } from "../src/parser.js";

describe("parseRateLimitMessage", () => {
  it("returns null for unrelated text", () => {
    expect(parseRateLimitMessage("Hello, the build succeeded.")).toBeNull();
  });

  it("parses an explicit ISO timestamp", () => {
    const result = parseRateLimitMessage(
      "You've hit your usage limit. It resets at 2026-07-13T05:00:00Z. Try again later."
    );
    expect(result).not.toBeNull();
    expect(result?.resetAt).toBe("2026-07-13T05:00:00.000Z");
    expect(result?.pattern).toBe("iso-timestamp");
  });

  it("parses a 12-hour clock time and rolls to the next day if already past", () => {
    const now = new Date("2026-07-12T20:00:00Z"); // 20:00 UTC
    const result = parseRateLimitMessage("Usage limit reached. Resets at 3:00pm.", { now });
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("clock-time");
    const resetDate = new Date(result!.resetAt);
    expect(resetDate.getUTCHours() === 15 || resetDate.getHours() === 15).toBeTruthy();
    expect(resetDate.getTime()).toBeGreaterThan(now.getTime());
  });

  it("parses a relative duration like '4h32m'", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("Rate limit exceeded, try again in 4h32m.", { now });
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("relative-duration");
    const expected = new Date(now.getTime() + (4 * 60 + 32) * 60_000).toISOString();
    expect(result?.resetAt).toBe(expected);
  });

  it("parses a relative duration with only minutes", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("resets in 45m", { now });
    expect(result).not.toBeNull();
    const expected = new Date(now.getTime() + 45 * 60_000).toISOString();
    expect(result?.resetAt).toBe(expected);
  });

  it("parses a unix epoch retry_after field", () => {
    const result = parseRateLimitMessage("rate_limit_error retry_after=1752345600");
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("unix-epoch");
    expect(result?.resetAt).toBe(new Date(1752345600 * 1000).toISOString());
  });

  it("falls back to a 5-hour window when no explicit time is present", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("You have reached your 5-hour usage limit.", { now });
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("five-hour-window-fallback");
    const expected = new Date(now.getTime() + 5 * 60 * 60_000).toISOString();
    expect(result?.resetAt).toBe(expected);
  });

  it("prefers the more specific pattern when multiple could match", () => {
    const result = parseRateLimitMessage(
      "Usage limit reached. It resets at 2026-07-13T05:00:00Z (in about 5 hours)."
    );
    expect(result?.pattern).toBe("iso-timestamp");
  });

  // --- Edge-case regression coverage (BACKLOG: 다양한 rate-limit 메시지 포맷 회귀 케이스) ---

  it("parses a 24-hour clock time", () => {
    const now = new Date("2026-07-12T08:00:00Z");
    const result = parseRateLimitMessage("Rate limit hit. Resets at 15:30.", { now });
    expect(result?.pattern).toBe("clock-time");
    const d = new Date(result!.resetAt);
    expect(d.getTime()).toBeGreaterThan(now.getTime());
    expect(d.getMinutes()).toBe(30);
  });

  it("treats 12:00am as midnight and 12:00pm as noon", () => {
    const now = new Date("2026-07-12T06:00:00Z");
    const midnight = parseRateLimitMessage("resets at 12:00am", { now });
    const noon = parseRateLimitMessage("resets at 12:00pm", { now });
    expect(new Date(midnight!.resetAt).getHours()).toBe(0);
    expect(new Date(noon!.resetAt).getHours()).toBe(12);
  });

  it("parses a relative duration with only hours ('try again in 2h')", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("Rate limit exceeded, try again in 2h.", { now });
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 2 * 60 * 60_000).toISOString());
  });

  it("parses a spelled-out relative duration ('retry in 5 hours')", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("Please retry in 5 hours.", { now });
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 5 * 60 * 60_000).toISOString());
  });

  it("is case-insensitive and tolerates surrounding noise / newlines", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const blob = [
      "some tool banner",
      "ERROR: RATE LIMIT REACHED",
      "  Details: RESETS IN 30M",
      "goodbye",
    ].join("\n");
    const result = parseRateLimitMessage(blob, { now });
    expect(result?.resetAt).toBe(new Date(now.getTime() + 30 * 60_000).toISOString());
  });

  it("parses an ISO timestamp with a timezone offset", () => {
    const result = parseRateLimitMessage("usage limit; resets at 2026-07-13T05:00:00+09:00");
    expect(result?.pattern).toBe("iso-timestamp");
    expect(result?.resetAt).toBe(new Date("2026-07-13T05:00:00+09:00").toISOString());
  });

  it("accepts retry_after with a colon and whitespace", () => {
    const result = parseRateLimitMessage("rate_limit_error retry_after: 1752345600");
    expect(result?.pattern).toBe("unix-epoch");
    expect(result?.resetAt).toBe(new Date(1752345600 * 1000).toISOString());
  });

  it("does not mis-parse a 13-digit millisecond retry_after as seconds", () => {
    // Would otherwise resolve to a year ~57000 date. Better to skip than to be wrong.
    const result = parseRateLimitMessage("retry_after=1752345600000");
    expect(result).toBeNull();
  });

  it("returns null for a rate-limit-ish line with no parseable reset time", () => {
    // Documents current behavior: without a recoverable time we can't schedule a resume.
    expect(parseRateLimitMessage("Error: rate limit exceeded. Please slow down.")).toBeNull();
  });

  it("ignores a zero-length relative duration ('try again in a moment')", () => {
    expect(parseRateLimitMessage("Rate limit; try again in a moment.")).toBeNull();
  });
});
