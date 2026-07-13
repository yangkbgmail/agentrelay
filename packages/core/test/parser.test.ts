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

  // --- Edge-case regression coverage (real-world message-format variety) ---

  it("parses an ISO timestamp with an explicit +00:00 offset", () => {
    const result = parseRateLimitMessage("Usage limit. resets at 2026-07-13T05:00:00+00:00.");
    expect(result?.pattern).toBe("iso-timestamp");
    expect(result?.resetAt).toBe("2026-07-13T05:00:00.000Z");
  });

  it("parses an ISO timestamp carrying fractional seconds", () => {
    const result = parseRateLimitMessage("rate limit — resets at 2026-07-13T05:00:00.500Z");
    expect(result?.pattern).toBe("iso-timestamp");
    expect(result?.resetAt).toBe("2026-07-13T05:00:00.500Z");
  });

  it("handles a 12am clock time as midnight, not noon", () => {
    const now = new Date("2026-07-12T20:00:00Z");
    const result = parseRateLimitMessage("resets at 12:00am", { now });
    expect(result?.pattern).toBe("clock-time");
    const reset = new Date(result!.resetAt);
    expect(reset.getHours()).toBe(0);
    expect(reset.getTime()).toBeGreaterThan(now.getTime());
  });

  it("handles a 12pm clock time as noon", () => {
    const now = new Date("2026-07-12T01:00:00Z");
    const result = parseRateLimitMessage("resets at 12:00pm", { now });
    expect(result?.pattern).toBe("clock-time");
    expect(new Date(result!.resetAt).getHours()).toBe(12);
  });

  it("parses a relative duration expressed only in hours", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("try again in 2h", { now });
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 2 * 60 * 60_000).toISOString());
  });

  it("parses verbose relative-duration wording ('retry in 3 hours 15 minutes')", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("Please retry in 3 hours 15 minutes.", { now });
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + (3 * 60 + 15) * 60_000).toISOString());
  });

  it("matches rate-limit messages case-insensitively", () => {
    const result = parseRateLimitMessage("USAGE LIMIT REACHED. RESETS AT 2026-07-13T05:00:00Z.");
    expect(result?.pattern).toBe("iso-timestamp");
  });

  it("finds the reset time even when buried in noisy multi-line output", () => {
    const noisy = [
      "Thinking...",
      "Editing file src/index.ts",
      "Error: You have hit your usage limit for this window.",
      "It resets at 2026-07-13T05:00:00Z. See docs for details.",
      "Exiting.",
    ].join("\n");
    const result = parseRateLimitMessage(noisy);
    expect(result?.pattern).toBe("iso-timestamp");
    expect(result?.resetAt).toBe("2026-07-13T05:00:00.000Z");
  });

  it("returns null when a limit-ish keyword appears but no usable time can be extracted", () => {
    // "resets in" with no parseable duration should not fabricate a time.
    expect(parseRateLimitMessage("Your limit resets in a little while, hang tight.")).toBeNull();
  });

  it("ignores a malformed ISO timestamp rather than returning NaN", () => {
    // Not a real date; the iso pattern's regex won't match a 13th month, so it
    // must not surface a bogus resetAt.
    const result = parseRateLimitMessage("usage limit, resets at 2026-13-40T99:00:00Z");
    expect(result === null || !Number.isNaN(new Date(result.resetAt).getTime())).toBe(true);
  });

  it("does not treat a plain success message as a rate limit", () => {
    expect(parseRateLimitMessage("Done. Committed 3 files and pushed to origin.")).toBeNull();
  });
});
