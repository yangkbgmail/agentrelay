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

  it("parses the real Claude Code wording: 'reset at 5pm' (hour + meridiem, no minutes)", () => {
    // Actual message: "Claude usage limit reached. Your limit will reset at 5pm (America/New_York)."
    const now = new Date("2026-07-12T08:00:00Z"); // 08:00 UTC
    const result = parseRateLimitMessage(
      "Claude usage limit reached. Your limit will reset at 5pm (America/New_York).",
      { now }
    );
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("clock-time-meridiem");
    const resetDate = new Date(result!.resetAt);
    expect(resetDate.getHours()).toBe(17); // 5pm local
    expect(resetDate.getMinutes()).toBe(0);
    expect(resetDate.getTime()).toBeGreaterThan(now.getTime());
  });

  it("parses 'resets at 10 AM' with a space before the meridiem, rolling to tomorrow if past", () => {
    const now = new Date("2026-07-12T20:00:00Z");
    const result = parseRateLimitMessage("Usage limit reached. Resets at 10 AM.", { now });
    expect(result?.pattern).toBe("clock-time-meridiem");
    const resetDate = new Date(result!.resetAt);
    expect(resetDate.getHours()).toBe(10);
    expect(resetDate.getTime()).toBeGreaterThan(now.getTime());
  });

  it("handles meridiem-only 12am (midnight) and 12pm (noon)", () => {
    const midnight = new Date(parseRateLimitMessage("resets at 12am")!.resetAt);
    expect(midnight.getHours()).toBe(0);
    const noon = new Date(parseRateLimitMessage("resets at 12pm")!.resetAt);
    expect(noon.getHours()).toBe(12);
  });

  it("still prefers minute-precise clock-time over the meridiem-only pattern", () => {
    const now = new Date("2026-07-12T08:00:00Z");
    const result = parseRateLimitMessage("Resets at 5:30pm.", { now });
    expect(result?.pattern).toBe("clock-time");
    const resetDate = new Date(result!.resetAt);
    expect(resetDate.getMinutes()).toBe(30);
  });

  it("does not treat a bare 'reset at 5' (no minutes, no meridiem) as a clock time", () => {
    // Too ambiguous — could be "5 hours", "5th", etc. Requiring am/pm keeps us safe.
    expect(parseRateLimitMessage("Rate limit hit, reset at 5.")).toBeNull();
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

  it("parses a relative duration expressed in days (weekly/daily windows)", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("Weekly usage limit reached, try again in 2 days.", { now });
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 2 * 24 * 60 * 60_000).toISOString());
  });

  it("parses a combined day + hour relative duration like '1d 4h'", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("Rate limit hit — resets in 1d 4h.", { now });
    expect(result?.pattern).toBe("relative-duration");
    const expected = new Date(now.getTime() + (24 + 4) * 60 * 60_000).toISOString();
    expect(result?.resetAt).toBe(expected);
  });

  it("parses the singular 'in 1 day' form", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("Usage limit reached. Try again in 1 day.", { now });
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 24 * 60 * 60_000).toISOString());
  });

  it("does not mistake minutes for days ('in 3 minutes')", () => {
    // Regression: the new day group must not swallow the leading number of a
    // minutes-only wait.
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("Rate limit exceeded, try again in 3 minutes.", { now });
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 3 * 60_000).toISOString());
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
    const result = parseRateLimitMessage("Usage limit reached. It resets at 2026-07-13T05:00:00Z (in about 5 hours).");
    expect(result?.pattern).toBe("iso-timestamp");
  });

  // --- edge-case regression coverage (BACKLOG: 다양한 rate-limit 메시지 포맷) ---

  it("returns null for an empty string", () => {
    expect(parseRateLimitMessage("")).toBeNull();
  });

  it("returns null for a rate-limit mention with no parseable reset time", () => {
    // Caller should treat this like a normal completion, not queue forever.
    expect(parseRateLimitMessage("Error: you are rate limited.")).toBeNull();
  });

  it("returns null when 'try again' appears with no 'in <duration>'", () => {
    expect(parseRateLimitMessage("Something went wrong, please try again.")).toBeNull();
  });

  it("is case-insensitive across patterns", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("USAGE LIMIT REACHED. RESETS IN 30M.", { now });
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 30 * 60_000).toISOString());
  });

  it("parses a 24-hour clock time", () => {
    const now = new Date("2026-07-12T08:00:00Z");
    const result = parseRateLimitMessage("Resets at 15:00.", { now });
    expect(result?.pattern).toBe("clock-time");
    expect(new Date(result!.resetAt).getTime()).toBeGreaterThan(now.getTime());
  });

  it("handles 12:00am (midnight) and 12:00pm (noon) correctly", () => {
    // 12:00am -> local hour 0, 12:00pm -> local hour 12 (interpreted in local time).
    const midnight = new Date(parseRateLimitMessage("resets at 12:00am")!.resetAt);
    expect(midnight.getHours()).toBe(0);
    const noon = new Date(parseRateLimitMessage("resets at 12:00pm")!.resetAt);
    expect(noon.getHours()).toBe(12);
  });

  it("parses an ISO timestamp with a timezone offset", () => {
    const result = parseRateLimitMessage("It resets at 2026-07-13T05:00:00+09:00.");
    expect(result?.pattern).toBe("iso-timestamp");
    // 05:00 +09:00 == 20:00 UTC the previous day.
    expect(result?.resetAt).toBe("2026-07-12T20:00:00.000Z");
  });

  it("falls through malformed ISO timestamps instead of returning an invalid date", () => {
    // Structurally matches the ISO regex but is not a real date -> no valid pattern.
    const result = parseRateLimitMessage("resets at 2026-13-40T99:99:99Z");
    expect(result).toBeNull();
  });

  it("parses a relative duration expressed only in hours", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("Rate limit hit — retry in 2 hours.", { now });
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 2 * 60 * 60_000).toISOString());
  });

  it("parses retry_after with a colon and surrounding whitespace", () => {
    const result = parseRateLimitMessage('{"error":"rate_limit","retry_after": 1752345600}');
    expect(result?.pattern).toBe("unix-epoch");
    expect(result?.resetAt).toBe(new Date(1752345600 * 1000).toISOString());
  });

  // --- Claude Code terse status-line wording (no "at", possibly no explicit
  //     rate-limit token) — real messages that previously failed to parse ---

  it("parses the status-line 'resets 3am' (meridiem, no 'at')", () => {
    // Actual Claude Code status line: "5-hour limit reached ∙ resets 3am"
    const now = new Date("2026-07-12T08:00:00Z");
    const result = parseRateLimitMessage("5-hour limit reached ∙ resets 3am", { now });
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("clock-time-meridiem");
    const resetDate = new Date(result!.resetAt);
    expect(resetDate.getHours()).toBe(3);
    expect(resetDate.getMinutes()).toBe(0);
    expect(resetDate.getTime()).toBeGreaterThan(now.getTime());
  });

  it("parses the status-line 'resets 3:30pm' (minutes, no 'at')", () => {
    const now = new Date("2026-07-12T02:00:00Z");
    const result = parseRateLimitMessage("Approaching usage limit ∙ resets 3:30pm", { now });
    expect(result?.pattern).toBe("clock-time");
    const resetDate = new Date(result!.resetAt);
    expect(resetDate.getMinutes()).toBe(30);
    expect(resetDate.getTime()).toBeGreaterThan(now.getTime());
  });

  it("prefers the precise 'resets 3am' over the 5-hour fallback when both could match", () => {
    // The message mentions a "5-hour limit" but also gives an exact reset time;
    // the exact time must win over the generic 5h window.
    const now = new Date("2026-07-12T08:00:00Z");
    const result = parseRateLimitMessage("5-hour limit reached ∙ resets 3am", { now });
    expect(result?.pattern).toBe("clock-time-meridiem");
  });

  it("still queues 'N-hour limit reached' with no reset time via the 5-hour fallback", () => {
    // Regression: "limit reached" must trip the pre-filter so the fallback fires
    // even when neither "rate/usage limit" nor "resets at/in" is present.
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("5-hour limit reached", { now });
    expect(result?.pattern).toBe("five-hour-window-fallback");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 5 * 60 * 60_000).toISOString());
  });

  it("does not read 'resets 5 times per hour' as a clock time", () => {
    // The without-"at" broadening must not turn a plain count into a reset time.
    // (Trips the pre-filter via "hour", but no clock/duration pattern matches.)
    expect(parseRateLimitMessage("the limit resets 5 times per hour")).toBeNull();
  });

  it("finds the rate-limit line inside noisy multi-line CLI output", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const noisy = [
      "Reading files...",
      "Applying edits to src/index.ts",
      "",
      "API Error: usage limit reached. Try again in 1h30m.",
      "Exiting.",
    ].join("\n");
    const result = parseRateLimitMessage(noisy, { now });
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 90 * 60_000).toISOString());
  });
});
