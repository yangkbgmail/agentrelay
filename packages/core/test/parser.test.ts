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

  // --- Regression cases for real-world message formats ---

  it("parses Claude Code's whole-hour meridiem wording ('reset at 10am')", () => {
    const now = new Date("2026-07-12T20:00:00Z");
    const result = parseRateLimitMessage(
      "Claude usage limit reached. Your limit will reset at 10am.",
      { now }
    );
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("clock-time-meridiem");
    const resetDate = new Date(result!.resetAt);
    expect(resetDate.getHours()).toBe(10);
    expect(resetDate.getTime()).toBeGreaterThan(now.getTime());
  });

  it("parses '3 PM' with a space and uppercase meridiem", () => {
    const now = new Date("2026-07-12T08:00:00Z");
    const result = parseRateLimitMessage("Rate limit hit. Resets at 3 PM.", { now });
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("clock-time-meridiem");
    expect(new Date(result!.resetAt).getHours()).toBe(15);
  });

  it("does not misread a colon time as the meridiem-only pattern", () => {
    const now = new Date("2026-07-12T08:00:00Z");
    const result = parseRateLimitMessage("Resets at 3:30pm.", { now });
    // clock-time (with minutes) must win over clock-time-meridiem
    expect(result?.pattern).toBe("clock-time");
    const d = new Date(result!.resetAt);
    expect(d.getHours()).toBe(15);
    expect(d.getMinutes()).toBe(30);
  });

  it("parses 'please wait 30 minutes' imperative wording", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("Rate limit exceeded. Please wait 30 minutes.", { now });
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("please-wait");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 30 * 60_000).toISOString());
  });

  it("parses 'wait 90 seconds'", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("Usage limit — wait 90 seconds and retry.", { now });
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("please-wait");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 90 * 1000).toISOString());
  });

  it("parses 'wait 2 hours'", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("rate limit: please wait 2 hours.", { now });
    expect(result?.pattern).toBe("please-wait");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 2 * 60 * 60_000).toISOString());
  });

  it("parses a millisecond-precision retry_after epoch", () => {
    const ms = 1752345600000;
    const result = parseRateLimitMessage(`rate_limit_error retry_after:${ms}`);
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("unix-epoch");
    expect(result?.resetAt).toBe(new Date(ms).toISOString());
  });

  it("still parses second-precision retry_after epoch alongside the ms variant", () => {
    const result = parseRateLimitMessage("retry_after=1752345600");
    expect(result?.resetAt).toBe(new Date(1752345600 * 1000).toISOString());
  });

  it("ignores a zero-length wait", () => {
    // "wait 0 minutes" gives no useful reset time; parser should reject it and
    // fall through (here there is nothing else to match).
    expect(parseRateLimitMessage("please wait 0 minutes")).toBeNull();
  });
});
