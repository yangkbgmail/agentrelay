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

  // --- Real-world message-format regression cases (BACKLOG 👷: edge cases) ---

  it("parses Claude's 'reset at 3pm' hour-plus-meridiem form (no minutes)", () => {
    const now = new Date("2026-07-12T08:00:00Z");
    const result = parseRateLimitMessage("Claude usage limit reached. Your limit will reset at 3pm.", { now });
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("clock-meridiem");
    const reset = new Date(result!.resetAt);
    expect(reset.getHours()).toBe(15);
    expect(reset.getTime()).toBeGreaterThan(now.getTime());
  });

  it("parses 'will reset at 10 am' with a space before the meridiem", () => {
    const now = new Date("2026-07-12T20:00:00Z");
    const result = parseRateLimitMessage("Your limit will reset at 10 am.", { now });
    expect(result?.pattern).toBe("clock-meridiem");
    expect(new Date(result!.resetAt).getHours()).toBe(10);
  });

  it("parses a fuzzy relative duration like 'try again in about 4 hours'", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("Rate limit exceeded. Try again in about 4 hours.", { now });
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 4 * 60 * 60_000).toISOString());
  });

  it("parses '~90 minutes' with a tilde and 'minutes' spelled out", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("resets in ~90 minutes", { now });
    expect(result?.resetAt).toBe(new Date(now.getTime() + 90 * 60_000).toISOString());
  });

  it("parses 'available again in 2 hrs' with abbreviated units", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("Quota exhausted; available again in 2 hrs.", { now });
    expect(result?.resetAt).toBe(new Date(now.getTime() + 2 * 60 * 60_000).toISOString());
  });

  it("parses an HTTP-style 'Retry-After: 3600' header as a delay in seconds", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("HTTP 429 rate_limit_error. Retry-After: 3600", { now });
    expect(result?.pattern).toBe("retry-after-seconds");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 3600 * 1000).toISOString());
  });

  it("still treats a 10-digit retry-after value as a unix epoch, not seconds", () => {
    const result = parseRateLimitMessage("rate_limit_error retry-after: 1752345600");
    expect(result?.pattern).toBe("unix-epoch");
    expect(result?.resetAt).toBe(new Date(1752345600 * 1000).toISOString());
  });

  it("does not misfire on ordinary output that merely mentions a time", () => {
    expect(parseRateLimitMessage("The meeting is at 3pm, see you there.")).toBeNull();
    expect(parseRateLimitMessage("Retrying the flaky test now.")).toBeNull();
  });
});
