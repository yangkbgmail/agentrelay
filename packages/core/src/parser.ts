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
 * Signed offset (ms) of an IANA time zone at a given instant, i.e. how far the
 * zone's wall clock is ahead of UTC (positive east of UTC, e.g. +9h for
 * Asia/Seoul, −4h for America/New_York in summer). Computed from `Intl` so it
 * respects DST at that instant. Throws `RangeError` for an unknown zone name —
 * callers catch it and treat the zone as unrecognised.
 */
function zoneOffsetMs(timeZone: string, instant: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUTC - instant.getTime();
}

/**
 * The absolute instant at which the wall clock in `timeZone` reads
 * `year-month-day hour:minute:00`. Inverts {@link zoneOffsetMs}: we guess by
 * treating the wall-clock fields as UTC, correct by the zone's offset, then do
 * one more correction so a DST transition between the guess and the corrected
 * instant is accounted for (the offset can differ across the jump).
 */
function zonedWallClockToInstant(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): Date {
  const guessUTC = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = zoneOffsetMs(timeZone, new Date(guessUTC));
  let instant = guessUTC - offset1;
  const offset2 = zoneOffsetMs(timeZone, new Date(instant));
  if (offset2 !== offset1) instant = guessUTC - offset2;
  return new Date(instant);
}

/**
 * The next instant strictly after `now` at which the wall clock in `timeZone`
 * reads `hour:minute` — i.e. "today in that zone if still ahead, else
 * tomorrow". Returns `null` if the zone name is not a valid IANA zone. Used by
 * the `clock-time-zoned` pattern so a reset stamped with its real zone
 * ("reset at 5pm (America/New_York)") resolves to the correct absolute instant
 * instead of being (mis)read in the relay host's local time.
 */
function nextTimeInZone(now: Date, hour: number, minute: number, timeZone: string): Date | null {
  let year: number;
  let month: number;
  let day: number;
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts: Record<string, string> = {};
    for (const p of dtf.formatToParts(now)) parts[p.type] = p.value;
    year = Number(parts.year);
    month = Number(parts.month);
    day = Number(parts.day);
  } catch {
    return null; // unknown/invalid time zone
  }

  // Try the target time on the zone's current calendar day, then the next day.
  for (let i = 0; i < 2; i++) {
    const candidate = zonedWallClockToInstant(timeZone, year, month, day, hour, minute);
    if (candidate.getTime() > now.getTime()) return candidate;
    const nextDay = new Date(Date.UTC(year, month - 1, day) + 24 * 60 * 60_000);
    year = nextDay.getUTCFullYear();
    month = nextDay.getUTCMonth() + 1;
    day = nextDay.getUTCDate();
  }
  // Both candidates were somehow in the past (only reachable via a >24h DST
  // anomaly); fall back to the last computed candidate rather than returning
  // a stale time.
  return zonedWallClockToInstant(timeZone, year, month, day, hour, minute);
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
    // "reset at 5pm (America/New_York)" / "resets at 15:00 Asia/Seoul" —
    // a clock time carrying its real IANA zone name. This is the exact wording
    // Claude Code prints ("Your limit will reset at 5pm (America/New_York)."),
    // and unlike the local-time clock-time patterns below we honour the zone:
    // the reset is resolved to the correct absolute instant regardless of the
    // relay host's own local time. The zone token must contain a "/" (e.g.
    // Continent/City), which both identifies an IANA name and keeps this
    // disjoint from bare abbreviations/offsets. Placed before the local-time
    // clock patterns so a zoned message wins; a message with no zone falls
    // through to them unchanged.
    name: "clock-time-zoned",
    regex: /reset[s]?\s+at\s+(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm)\b)?\s*\(?\s*([A-Za-z]+(?:\/[A-Za-z_]+)+)\)?/i,
    resolve: (m, now) => {
      let hour = parseInt(m[1], 10);
      const minute = m[2] ? parseInt(m[2], 10) : 0;
      const meridiem = m[3]?.toLowerCase();
      if (meridiem) {
        if (hour > 12) return null; // "15pm" is not a valid 12-hour clock time
        if (meridiem === "pm" && hour < 12) hour += 12;
        if (meridiem === "am" && hour === 12) hour = 0;
      }
      if (hour > 23 || minute > 59) return null;
      return nextTimeInZone(now, hour, minute, m[4]);
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
