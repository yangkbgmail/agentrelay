import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_RESET_HORIZON_MS,
  isPlausibleReset,
  isValidTimeZone,
  maxResetHorizonMsFromEnv,
  nextClockInstant,
  parseRateLimitMessage,
  timeZoneOffsetMs,
  zonedWallToUtc,
} from "../src/parser.js";

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

  it("parses the real Claude Code wording and honors the named timezone: 'reset at 5pm (America/New_York)'", () => {
    // Actual message: "Claude usage limit reached. Your limit will reset at 5pm (America/New_York)."
    // 2026-07-12 is EDT (UTC-4), so 5pm New York == 21:00 UTC. The result must be
    // that exact instant regardless of the machine's local timezone.
    const now = new Date("2026-07-12T08:00:00Z"); // 08:00 UTC
    const result = parseRateLimitMessage(
      "Claude usage limit reached. Your limit will reset at 5pm (America/New_York).",
      { now }
    );
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("clock-time-meridiem");
    expect(result?.resetAt).toBe("2026-07-12T21:00:00.000Z");
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

  it("honors a timezone on the minute-precise clock-time pattern (winter, EST)", () => {
    // 2026-01-15 is EST (UTC-5), so 3:30pm New York == 20:30 UTC.
    const now = new Date("2026-01-15T08:00:00Z");
    const result = parseRateLimitMessage("Usage limit reached. Resets at 3:30pm (America/New_York).", { now });
    expect(result?.pattern).toBe("clock-time");
    expect(result?.resetAt).toBe("2026-01-15T20:30:00.000Z");
  });

  it("honors a timezone on a 24-hour clock time without parentheses", () => {
    // 2026-01-15 London is GMT (UTC+0), so 15:00 == 15:00 UTC.
    const now = new Date("2026-01-15T08:00:00Z");
    const result = parseRateLimitMessage("Usage limit reached. Resets at 15:00 Europe/London.", { now });
    expect(result?.pattern).toBe("clock-time");
    expect(result?.resetAt).toBe("2026-01-15T15:00:00.000Z");
  });

  it("rolls the zoned reset to tomorrow when today's wall time has already passed", () => {
    // now is 2026-07-12T22:00Z == 18:00 EDT, already past 5pm NY today, so next 5pm
    // NY is 2026-07-13T21:00Z.
    const now = new Date("2026-07-12T22:00:00Z");
    const result = parseRateLimitMessage("Your limit will reset at 5pm (America/New_York).", { now });
    expect(result?.resetAt).toBe("2026-07-13T21:00:00.000Z");
  });

  it("falls back to local time when the captured timezone is not a real IANA zone", () => {
    const now = new Date("2026-07-12T08:00:00Z");
    // "Mars/Phobos" trips the Region/City shape but isn't a valid zone → same as no zone.
    const withBadZone = parseRateLimitMessage("Resets at 5pm (Mars/Phobos).", { now });
    const withoutZone = parseRateLimitMessage("Resets at 5pm.", { now });
    expect(withBadZone?.resetAt).toBe(withoutZone?.resetAt);
    expect(withBadZone?.pattern).toBe("clock-time-meridiem");
  });

  describe("timezone helpers", () => {
    it("isValidTimeZone recognizes real zones and rejects junk", () => {
      expect(isValidTimeZone("America/New_York")).toBe(true);
      expect(isValidTimeZone("Europe/London")).toBe(true);
      expect(isValidTimeZone("UTC")).toBe(true);
      expect(isValidTimeZone("Mars/Phobos")).toBe(false);
      expect(isValidTimeZone("")).toBe(false);
    });

    it("timeZoneOffsetMs is DST-aware", () => {
      const hourMs = 60 * 60_000;
      // EDT in July (UTC-4), EST in January (UTC-5).
      expect(timeZoneOffsetMs("America/New_York", new Date("2026-07-12T12:00:00Z"))).toBe(-4 * hourMs);
      expect(timeZoneOffsetMs("America/New_York", new Date("2026-01-15T12:00:00Z"))).toBe(-5 * hourMs);
      expect(timeZoneOffsetMs("UTC", new Date("2026-07-12T12:00:00Z"))).toBe(0);
    });

    it("zonedWallToUtc converts a wall time in a zone to the correct UTC instant", () => {
      expect(zonedWallToUtc(2026, 7, 12, 17, 0, "America/New_York").toISOString()).toBe("2026-07-12T21:00:00.000Z");
      expect(zonedWallToUtc(2026, 1, 15, 17, 0, "America/New_York").toISOString()).toBe("2026-01-15T22:00:00.000Z");
    });

    it("nextClockInstant rolls forward and honors the zone", () => {
      const now = new Date("2026-07-12T22:00:00Z"); // 18:00 EDT
      // 5pm NY already passed today → tomorrow 5pm NY.
      expect(nextClockInstant(now, 17, 0, "America/New_York").toISOString()).toBe("2026-07-13T21:00:00.000Z");
      // 11pm NY (23:00 EDT == 03:00Z next day) is still ahead of 18:00 EDT today.
      expect(nextClockInstant(now, 23, 0, "America/New_York").toISOString()).toBe("2026-07-13T03:00:00.000Z");
    });
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

  it("parses the HTTP Retry-After header in delay-seconds form", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("HTTP 429 Too Many Requests\nRetry-After: 3600", { now });
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("http-retry-after");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 3600 * 1000).toISOString());
  });

  it("parses the HTTP Retry-After header in HTTP-date form", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("429: Retry-After: Wed, 21 Oct 2026 07:28:00 GMT", { now });
    expect(result?.pattern).toBe("http-retry-after");
    expect(result?.resetAt).toBe("2026-10-21T07:28:00.000Z");
  });

  it("treats Retry-After: 0 as an immediate resume", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("Retry-After: 0", { now });
    expect(result?.pattern).toBe("http-retry-after");
    expect(result?.resetAt).toBe(now.toISOString());
  });

  it("does not confuse the JSON retry_after epoch field with the HTTP header", () => {
    // Underscore form stays an absolute epoch (unix-epoch); hyphen form is a
    // relative HTTP header — the two must not cross-match.
    const result = parseRateLimitMessage("retry_after=1752345600");
    expect(result?.pattern).toBe("unix-epoch");
  });

  it("falls through a malformed HTTP-date Retry-After instead of an invalid date", () => {
    const result = parseRateLimitMessage("Retry-After: Not, 99 Xxx 0000 99:99:99 GMT");
    expect(result).toBeNull();
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

  // --- reset-time plausibility guard (maxFutureMs) ---

  it("ignores an implausibly far-future reset when a horizon is set", () => {
    // "try again in 30 days" resolves 30d out — well past an 8-day horizon, so
    // it's treated as a misparse and dropped rather than parking a job a month.
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("Rate limit exceeded, try again in 30 days.", {
      now,
      maxFutureMs: DEFAULT_MAX_RESET_HORIZON_MS,
    });
    expect(result).toBeNull();
  });

  it("keeps a reset that lands within the horizon", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("Weekly usage limit reached, try again in 2 days.", {
      now,
      maxFutureMs: DEFAULT_MAX_RESET_HORIZON_MS,
    });
    expect(result?.pattern).toBe("relative-duration");
    expect(result?.resetAt).toBe(new Date(now.getTime() + 2 * 24 * 60 * 60_000).toISOString());
  });

  it("only bounds the future — a reset in the past is still accepted under a horizon", () => {
    // A wrong-units epoch resolving to 2001 is in the past; resuming immediately
    // is safe, so the guard (future-only) must not drop it.
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("rate_limit_error retry_after=1000000000", {
      now,
      maxFutureMs: DEFAULT_MAX_RESET_HORIZON_MS,
    });
    expect(result?.pattern).toBe("unix-epoch");
    expect(result?.resetAt).toBe(new Date(1000000000 * 1000).toISOString());
  });

  it("falls through to a saner pattern when the first match is implausibly far out", () => {
    // A far-future adapter epoch (year ~2286) is rejected, so the generic
    // relative-duration below it wins instead of the job being parked centuries.
    const now = new Date("2026-07-12T10:00:00Z");
    const farEpoch = {
      name: "test-far-epoch",
      regex: /epoch=(\d+)/,
      resolve: (m: RegExpMatchArray) => new Date(Number.parseInt(m[1], 10) * 1000),
    };
    const text = "usage limit reached epoch=9999999999 — try again in 15m";
    const guarded = parseRateLimitMessage(text, {
      now,
      maxFutureMs: DEFAULT_MAX_RESET_HORIZON_MS,
      extraPatterns: [farEpoch],
    });
    expect(guarded?.pattern).toBe("relative-duration");
    expect(guarded?.resetAt).toBe(new Date(now.getTime() + 15 * 60_000).toISOString());
    // Without the guard, the far-future epoch would win.
    const unguarded = parseRateLimitMessage(text, { now, extraPatterns: [farEpoch] });
    expect(unguarded?.pattern).toBe("test-far-epoch");
  });

  it("treats a non-positive horizon as no guard", () => {
    const now = new Date("2026-07-12T10:00:00Z");
    const result = parseRateLimitMessage("try again in 30 days.", { now, maxFutureMs: 0 });
    expect(result?.pattern).toBe("relative-duration");
  });
});

describe("isPlausibleReset", () => {
  const now = new Date("2026-07-12T10:00:00Z");

  it("returns true when no horizon is supplied", () => {
    const farOut = new Date(now.getTime() + 365 * 24 * 60 * 60_000);
    expect(isPlausibleReset(farOut, now)).toBe(true);
    expect(isPlausibleReset(farOut, now, null)).toBe(true);
    expect(isPlausibleReset(farOut, now, 0)).toBe(true);
    expect(isPlausibleReset(farOut, now, -5)).toBe(true);
    expect(isPlausibleReset(farOut, now, Number.POSITIVE_INFINITY)).toBe(true);
  });

  it("bounds only the future side", () => {
    const horizon = 24 * 60 * 60_000; // 1 day
    expect(isPlausibleReset(new Date(now.getTime() + horizon), now, horizon)).toBe(true); // exactly at the edge
    expect(isPlausibleReset(new Date(now.getTime() + horizon + 1), now, horizon)).toBe(false);
    expect(isPlausibleReset(new Date(now.getTime() - 999 * horizon), now, horizon)).toBe(true); // past is fine
  });
});

describe("maxResetHorizonMsFromEnv", () => {
  it("defaults to the 8-day horizon when unset or blank", () => {
    expect(maxResetHorizonMsFromEnv({})).toBe(DEFAULT_MAX_RESET_HORIZON_MS);
    expect(maxResetHorizonMsFromEnv({ AGENTRELAY_MAX_RESET_HORIZON: "  " })).toBe(DEFAULT_MAX_RESET_HORIZON_MS);
  });

  it("parses an explicit duration", () => {
    expect(maxResetHorizonMsFromEnv({ AGENTRELAY_MAX_RESET_HORIZON: "25h" })).toBe(25 * 60 * 60_000);
    expect(maxResetHorizonMsFromEnv({ AGENTRELAY_MAX_RESET_HORIZON: "2d" })).toBe(2 * 24 * 60 * 60_000);
  });

  it("disables the guard for 0/off/none/unparseable", () => {
    expect(maxResetHorizonMsFromEnv({ AGENTRELAY_MAX_RESET_HORIZON: "0" })).toBeNull();
    expect(maxResetHorizonMsFromEnv({ AGENTRELAY_MAX_RESET_HORIZON: "off" })).toBeNull();
    expect(maxResetHorizonMsFromEnv({ AGENTRELAY_MAX_RESET_HORIZON: "none" })).toBeNull();
    expect(maxResetHorizonMsFromEnv({ AGENTRELAY_MAX_RESET_HORIZON: "banana" })).toBeNull();
  });
});
