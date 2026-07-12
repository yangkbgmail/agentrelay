import { describe, expect, it } from "vitest";
import { parseRateLimitMessage } from "../src/parser.js";

/**
 * Regression corpus for real-world-ish rate-limit message variations. Agent
 * CLIs phrase these differently across versions, so each format that we claim
 * to support is locked in here. When a new wild format is observed, add the
 * raw line to this file first (red), then teach the parser to handle it.
 */
describe("parseRateLimitMessage — format regressions", () => {
  const now = new Date("2026-07-12T10:00:00Z");

  it("is case-insensitive for the reset keyword", () => {
    const result = parseRateLimitMessage("USAGE LIMIT. RESETS AT 2026-07-13T05:00:00Z.", { now });
    expect(result?.pattern).toBe("iso-timestamp");
    expect(result?.resetAt).toBe("2026-07-13T05:00:00.000Z");
  });

  it("honours an ISO timestamp with a timezone offset", () => {
    const result = parseRateLimitMessage("Rate limit — resets at 2026-07-13T14:00:00+09:00.", { now });
    expect(result?.pattern).toBe("iso-timestamp");
    // 14:00 +09:00 == 05:00 UTC
    expect(result?.resetAt).toBe("2026-07-13T05:00:00.000Z");
  });

  it("parses 'retry in 5 hours' spelled-out hours", () => {
    const result = parseRateLimitMessage("Rate limit exceeded. Retry in 5 hours.", { now });
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 5 * 60 * 60_000).toISOString());
  });

  it("parses 'try again in 2h' with only hours", () => {
    const result = parseRateLimitMessage("You are being rate limited, try again in 2h.", { now });
    expect(result?.resetAt).toBe(new Date(now.getTime() + 2 * 60 * 60_000).toISOString());
  });

  it("parses spelled-out minutes ('resets in 30 minutes')", () => {
    const result = parseRateLimitMessage("Usage limit hit; resets in 30 minutes.", { now });
    expect(result?.resetAt).toBe(new Date(now.getTime() + 30 * 60_000).toISOString());
  });

  it("parses retry_after with a colon separator", () => {
    const result = parseRateLimitMessage('{"error":"rate_limit","retry_after": 1752345600}', { now });
    expect(result?.pattern).toBe("unix-epoch");
    expect(result?.resetAt).toBe(new Date(1752345600 * 1000).toISOString());
  });

  it("parses a 24-hour clock time without a meridiem", () => {
    const result = parseRateLimitMessage("Usage limit reached. Resets at 15:00.", { now });
    expect(result?.pattern).toBe("clock-time");
    const reset = new Date(result!.resetAt);
    expect(reset.getUTCHours() === 15 || reset.getHours() === 15).toBeTruthy();
  });

  it("finds the rate-limit line buried in multi-line CLI output", () => {
    const output = [
      "Thinking...",
      "Editing src/index.ts",
      "Error: usage limit reached. Resets at 2026-07-13T05:00:00Z.",
      "Process exited.",
    ].join("\n");
    const result = parseRateLimitMessage(output, { now });
    expect(result?.pattern).toBe("iso-timestamp");
  });

  it("ignores unrelated 'limit' mentions (character/memory limits)", () => {
    expect(parseRateLimitMessage("Response exceeded the 80 character limit.", { now })).toBeNull();
    expect(parseRateLimitMessage("Reached the memory limit while indexing.", { now })).toBeNull();
  });

  it("returns null for a zero-duration relative match rather than scheduling immediately", () => {
    // "in 0h0m" resolves to no delay -> not a usable reset time.
    expect(parseRateLimitMessage("try again in 0h0m", { now })).toBeNull();
  });
});
