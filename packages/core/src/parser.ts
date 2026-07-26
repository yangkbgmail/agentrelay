import type { RateLimitInfo } from "./types.js";

/**
 * Parses CLI output from AI coding agents (Claude Code, etc.) looking for
 * rate-limit / usage-limit messages, and extracts when the limit resets.
 *
 * Designed to be defensive: agent CLIs change their exact wording over time,
 * so every pattern is matched independently and the first hit wins. Add new
 * patterns here as real-world message formats are observed — do not assume
 * this list is exhaustive.
 */

export interface ParseOptions {
  /** Injectable "now" for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
  /**
   * Tool-specific patterns tried *before* the built-in generic ones (highest
   * priority). Supplied by agent adapters (see `adapters.ts`) so a given tool
   * can recognize wording the generic parser doesn't. These bypass the generic
   * pre-filter, so an adapter can match formats that don't look rate-limit-y.
   */
  extraPatterns?: RateLimitPattern[];
}

/**
 * A single rate-limit message matcher. Exposed so agent adapters can contribute
 * tool-specific patterns without reaching into the parser internals.
 */
export interface RateLimitPattern {
  name: string;
  regex: RegExp;
  resolve: (match: RegExpMatchArray, now: Date) => Date | null;
}

/**
 * Parses a fixed-offset timezone token (as printed after a clock time, e.g.
 * `UTC`, `GMT`, `Z`, `UTC+9`, `GMT-5`, `UTC+05:30`, `GMT+0930`) into minutes
 * east of UTC. Returns null for anything else — a bare zone name, a named IANA
 * zone (`America/New_York`), or garbage — so the caller falls back to
 * local-time interpretation (a fixed offset can't be derived without a tz
 * database, so guessing would be worse than the documented local-time default).
 */
export function parseFixedOffset(zone: string, offset?: string): number | null {
  const z = zone.toLowerCase();
  if (z !== "utc" && z !== "gmt" && z !== "z") return null;
  // "Z" is UTC by definition and never carries a numeric offset.
  if (z === "z" || offset === undefined || offset === "") return 0;
  const sign = offset[0] === "-" ? -1 : 1;
  const digits = offset.slice(1).replace(":", "");
  let hours: number;
  let minutes: number;
  if (digits.length <= 2) {
    hours = parseInt(digits, 10);
    minutes = 0;
  } else {
    hours = parseInt(digits.slice(0, digits.length - 2), 10);
    minutes = parseInt(digits.slice(-2), 10);
  }
  if (Number.isNaN(hours) || Number.isNaN(minutes) || hours > 18 || minutes > 59) return null;
  return sign * (hours * 60 + minutes);
}

/**
 * Resolves a wall-clock `HH:MM` in an explicit fixed-offset zone to the next
 * future instant. Unlike the local-time clock patterns, this yields the correct
 * absolute UTC moment when the message states its zone (e.g. "reset at 10am
 * (UTC)"). Rolls to the next day-in-zone when the time has already passed today.
 */
function resolveZonedClock(hour: number, minute: number, offsetMin: number, now: Date): Date {
  // Calendar date of "now" *as seen in the target zone*.
  const zoneNow = new Date(now.getTime() + offsetMin * 60_000);
  const y = zoneNow.getUTCFullYear();
  const mo = zoneNow.getUTCMonth();
  const d = zoneNow.getUTCDate();
  // Wall-clock HH:MM on that zone date, expressed as the real UTC instant.
  let instant = Date.UTC(y, mo, d, hour, minute, 0, 0) - offsetMin * 60_000;
  if (instant <= now.getTime()) {
    instant = Date.UTC(y, mo, d + 1, hour, minute, 0, 0) - offsetMin * 60_000;
  }
  return new Date(instant);
}

/** Normalizes a 12-hour clock hour + optional meridiem to a 24-hour hour, or null if invalid. */
function to24Hour(hour: number, meridiem?: string): number | null {
  const mer = meridiem?.toLowerCase();
  if (mer === "am" || mer === "pm") {
    if (hour < 1 || hour > 12) return null; // 0/13+ are not valid 12-hour readings
    if (mer === "pm" && hour < 12) return hour + 12;
    if (mer === "am" && hour === 12) return 0;
    return hour;
  }
  return hour <= 23 ? hour : null; // bare 24-hour reading
}

const PATTERNS: RateLimitPattern[] = [
  {
    // "reset at 2026-07-13T05:00:00Z" or similar explicit ISO timestamps
    name: "iso-timestamp",
    regex: /reset[s]?\s+at\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i,
    resolve: (m) => {
      const d = new Date(m[1]);
      return Number.isNaN(d.getTime()) ? null : d;
    },
  },
  {
    // "resets at 3:00pm (UTC)" / "reset at 15:00 GMT+9" — same wall-clock forms
    // as `clock-time` below but with an *explicit* fixed-offset zone, so we can
    // compute the true absolute instant instead of assuming local time. Tried
    // before `clock-time` (first hit wins) so the zone is honored when present.
    // A named IANA zone (e.g. "(America/New_York)") makes `parseFixedOffset`
    // return null → resolve returns null → we fall through to the local pattern,
    // preserving the documented local-time behavior for zones we can't resolve.
    name: "clock-time-tz",
    regex: /reset[s]?\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)?\s*\(?\s*(utc|gmt|z)\s*([+-]\d{1,2}(?::?\d{2})?)?\s*\)?/i,
    resolve: (m, now) => {
      const offsetMin = parseFixedOffset(m[4], m[5]);
      if (offsetMin === null) return null;
      const hour = to24Hour(parseInt(m[1], 10), m[3]);
      if (hour === null) return null;
      return resolveZonedClock(hour, parseInt(m[2], 10), offsetMin, now);
    },
  },
  {
    // "resets at 5pm (UTC)" / "reset at 10 AM GMT-5" — hour + meridiem with NO
    // minutes, plus an explicit fixed-offset zone. Tried before
    // `clock-time-meridiem` so the zone wins when present (same fall-through to
    // local time for unresolvable named zones).
    name: "clock-time-meridiem-tz",
    regex: /reset[s]?\s+at\s+(\d{1,2})\s*(am|pm)\s*\(?\s*(utc|gmt|z)\s*([+-]\d{1,2}(?::?\d{2})?)?\s*\)?/i,
    resolve: (m, now) => {
      const offsetMin = parseFixedOffset(m[3], m[4]);
      if (offsetMin === null) return null;
      const hour = to24Hour(parseInt(m[1], 10), m[2]);
      if (hour === null) return null;
      return resolveZonedClock(hour, 0, offsetMin, now);
    },
  },
  {
    // "resets at 3:00pm" / "resets at 15:00" (assume today, or tomorrow if already past)
    name: "clock-time",
    regex: /reset[s]?\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i,
    resolve: (m, now) => {
      let hour = parseInt(m[1], 10);
      const minute = parseInt(m[2], 10);
      const meridiem = m[3]?.toLowerCase();
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
      const candidate = new Date(now);
      candidate.setHours(hour, minute, 0, 0);
      if (candidate.getTime() <= now.getTime()) {
        candidate.setDate(candidate.getDate() + 1);
      }
      return candidate;
    },
  },
  {
    // "resets at 5pm" / "reset at 10 AM" — hour + meridiem with NO minutes.
    // This is the wording Claude Code actually prints ("Your limit will reset
    // at 5pm (America/New_York)."), which the minute-requiring clock-time
    // pattern above misses. Meridiem is required: a bare "reset at 5" (no
    // colon, no am/pm) is too ambiguous to treat as a clock time. The named
    // timezone in the message is ignored — the hour is interpreted in local
    // time, same known limitation as clock-time (a real reset is a future
    // instant, so rolling to tomorrow when already past keeps us safe).
    name: "clock-time-meridiem",
    regex: /reset[s]?\s+at\s+(\d{1,2})\s*(am|pm)\b/i,
    resolve: (m, now) => {
      let hour = parseInt(m[1], 10);
      if (hour > 12) return null; // 13pm etc. is not a valid 12-hour clock time
      const meridiem = m[2].toLowerCase();
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
      const candidate = new Date(now);
      candidate.setHours(hour, 0, 0, 0);
      if (candidate.getTime() <= now.getTime()) {
        candidate.setDate(candidate.getDate() + 1);
      }
      return candidate;
    },
  },
  {
    // "try again in 4h32m" / "retry in 5 hours" / "resets in 45m" / "resets in 2h" /
    // "try again in 2 days" / "resets in 1d 4h" — days cover weekly/daily usage
    // windows. Seconds are deliberately *not* handled here (see adapters.ts: they
    // are OpenAI/Codex-style wording that the Codex adapter contributes).
    name: "relative-duration",
    regex:
      /(?:try again|resets?|retry)\s+in\s+(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i,
    resolve: (m, now) => {
      const days = m[1] ? parseInt(m[1], 10) : 0;
      const hours = m[2] ? parseInt(m[2], 10) : 0;
      const minutes = m[3] ? parseInt(m[3], 10) : 0;
      if (days === 0 && hours === 0 && minutes === 0) return null;
      return new Date(now.getTime() + ((days * 24 + hours) * 60 + minutes) * 60_000);
    },
  },
  {
    // Unix epoch seconds embedded in structured error payloads, e.g.
    // `retry_after=1752345600`, `retry_after: 1752345600`, or the JSON form
    // `"retry_after": 1752345600`.
    name: "unix-epoch",
    regex: /retry_after"?\s*[=:]\s*(\d{10})/i,
    resolve: (m) => new Date(parseInt(m[1], 10) * 1000),
  },
  {
    // The standard HTTP `Retry-After` response header (RFC 9110 §10.2.3), which
    // agent CLIs proxying an HTTP API often dump verbatim on a 429. Two forms:
    //   - delay-seconds:  `Retry-After: 3600`   -> that many seconds from now
    //   - HTTP-date:      `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` -> absolute
    // The hyphenated header name keeps this disjoint from the JSON `retry_after`
    // (underscore) epoch field above. The numeric group is capped at 7 digits so
    // an epoch-looking value isn't misread as a (nonsensical) delay in seconds —
    // per spec Retry-After is a relative delay or a date, never an epoch.
    name: "http-retry-after",
    regex: /retry-after\s*:\s*(?:(\d{1,7})\b|([A-Za-z][^\r\n]*?GMT))/i,
    resolve: (m, now) => {
      if (m[1] !== undefined) return new Date(now.getTime() + parseInt(m[1], 10) * 1000);
      const d = new Date(m[2]);
      return Number.isNaN(d.getTime()) ? null : d;
    },
  },
  {
    // Generic "5-hour limit" mention with no explicit time -> assume a full 5h window from now.
    // Kept last and treated as a low-confidence fallback.
    name: "five-hour-window-fallback",
    regex: /5[\s-]?hour(?:ly)?\s+(?:usage\s+)?limit/i,
    resolve: (_m, now) => new Date(now.getTime() + 5 * 60 * 60_000),
  },
];

/** Quick pre-filter so we don't run every regex on every line of noisy CLI output. */
const LOOKS_LIKE_RATE_LIMIT = /(rate.?limit|usage limit|try again|resets?\s+(at|in)|retry.?after)/i;

function tryPattern(pattern: RateLimitPattern, text: string, now: Date): RateLimitInfo | null {
  const match = text.match(pattern.regex);
  if (!match) return null;
  const resetDate = pattern.resolve(match, now);
  if (!resetDate || Number.isNaN(resetDate.getTime())) return null;
  return {
    resetAt: resetDate.toISOString(),
    rawMatch: match[0],
    pattern: pattern.name,
  };
}

export function parseRateLimitMessage(text: string, options: ParseOptions = {}): RateLimitInfo | null {
  const now = options.now ?? new Date();

  // Tool-specific patterns win over the generic ones and are tried even when
  // the text doesn't trip the generic pre-filter (a tool may phrase things its
  // own way, e.g. "please try again in 20s").
  for (const pattern of options.extraPatterns ?? []) {
    const hit = tryPattern(pattern, text, now);
    if (hit) return hit;
  }

  if (!LOOKS_LIKE_RATE_LIMIT.test(text)) return null;

  for (const pattern of PATTERNS) {
    const hit = tryPattern(pattern, text, now);
    if (hit) return hit;
  }

  return null;
}
