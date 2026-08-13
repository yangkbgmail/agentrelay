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
 * The wall-clock fields of an instant as observed in a given IANA time zone.
 * Returns `null` when `zone` is not a zone this runtime's ICU data knows about
 * (or ICU is unavailable), so callers can degrade gracefully to local time.
 */
function zonedParts(
  instant: Date,
  zone: string
): { year: number; month: number; day: number; hour: number; minute: number; second: number } | null {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const map: Record<string, number> = {};
    for (const part of dtf.formatToParts(instant)) {
      if (part.type !== "literal") map[part.type] = Number.parseInt(part.value, 10);
    }
    // Some ICU builds render midnight as hour "24"; normalize to 0.
    const hour = map.hour === 24 ? 0 : map.hour;
    return { year: map.year, month: map.month, day: map.day, hour, minute: map.minute, second: map.second };
  } catch {
    return null; // unknown zone / no ICU
  }
}

/** Offset (zone wall-clock − UTC) in minutes for `instant`, or `null` if `zone` is unknown. */
function zoneOffsetMinutes(instant: Date, zone: string): number | null {
  const parts = zonedParts(instant, zone);
  if (!parts) return null;
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * Interpret a wall-clock date-time as it would read *in `zone`* and return the
 * corresponding UTC instant. Uses the standard two-pass offset correction so a
 * reset that lands on a DST transition resolves to the right instant. Day/month
 * overflow (e.g. `day + 1` past month-end) is normalized by `Date.UTC`.
 */
function zonedWallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string
): Date | null {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const off1 = zoneOffsetMinutes(new Date(guess), zone);
  if (off1 === null) return null;
  const instant = guess - off1 * 60_000;
  const off2 = zoneOffsetMinutes(new Date(instant), zone);
  // If the first guess straddled a DST change, the refined offset differs;
  // recompute against it so the wall-clock time is honoured on the correct side.
  if (off2 !== null && off2 !== off1) return new Date(guess - off2 * 60_000);
  return new Date(instant);
}

/**
 * The next future instant at which the wall clock in `zone` reads `hour:minute`.
 * Anchored to *today's* date in that zone, rolling to tomorrow if already past.
 * Returns `null` if `zone` is unknown so the caller can fall back to local time.
 */
function nextZonedClockInstant(now: Date, hour: number, minute: number, zone: string): Date | null {
  const today = zonedParts(now, zone);
  if (!today) return null;
  let instant = zonedWallToUtc(today.year, today.month, today.day, hour, minute, zone);
  if (!instant) return null;
  if (instant.getTime() <= now.getTime()) {
    instant = zonedWallToUtc(today.year, today.month, today.day + 1, hour, minute, zone);
  }
  return instant;
}

/** The next future instant at which the *local* wall clock reads `hour:minute`. */
function nextLocalClockInstant(now: Date, hour: number, minute: number): Date {
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

/**
 * Resolve a clock-time reset to a future instant, honouring an explicit IANA
 * time zone captured from the message (e.g. Claude Code's
 * "reset at 5pm (America/New_York)") when present and recognised. Falls back to
 * interpreting the hour in local time — the previous behaviour — when no zone is
 * given or the zone name is not one ICU knows.
 */
function resolveClockReset(now: Date, hour: number, minute: number, zone: string | undefined): Date {
  if (zone) {
    const zoned = nextZonedClockInstant(now, hour, minute, zone);
    if (zoned) return zoned;
  }
  return nextLocalClockInstant(now, hour, minute);
}

// IANA zone names as they appear parenthesised after a clock time, e.g.
// "(America/New_York)", "(Europe/London)", "(Asia/Kolkata)", "(Etc/GMT+5)".
// Kept permissive and validated at resolve time via ICU; a non-zone parenthetical
// (e.g. "(local time)") simply fails validation and falls back to local.
const ZONE_SUFFIX = /(?:\s*\(([A-Za-z][A-Za-z0-9_+\-/]*)\))?/.source;

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
    // "resets at 3:00pm" / "resets at 15:00" (assume today, or tomorrow if already
    // past). An optional parenthesised IANA zone — "resets at 9:30am (Europe/London)"
    // — is honoured when ICU recognises it (group 4); otherwise the hour is read in
    // local time.
    name: "clock-time",
    regex: new RegExp(`reset[s]?\\s+at\\s+(\\d{1,2}):(\\d{2})\\s*(am|pm)?${ZONE_SUFFIX}`, "i"),
    resolve: (m, now) => {
      let hour = parseInt(m[1], 10);
      const minute = parseInt(m[2], 10);
      const meridiem = m[3]?.toLowerCase();
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
      return resolveClockReset(now, hour, minute, m[4]);
    },
  },
  {
    // "resets at 5pm" / "reset at 10 AM" — hour + meridiem with NO minutes.
    // This is the wording Claude Code actually prints ("Your limit will reset
    // at 5pm (America/New_York)."), which the minute-requiring clock-time
    // pattern above misses. Meridiem is required: a bare "reset at 5" (no
    // colon, no am/pm) is too ambiguous to treat as a clock time. When the
    // message names an IANA time zone in parentheses (group 3) it is honoured;
    // otherwise the hour is interpreted in local time (rolling to tomorrow when
    // already past keeps a real, future reset safe either way).
    name: "clock-time-meridiem",
    regex: new RegExp(`reset[s]?\\s+at\\s+(\\d{1,2})\\s*(am|pm)\\b${ZONE_SUFFIX}`, "i"),
    resolve: (m, now) => {
      let hour = parseInt(m[1], 10);
      if (hour > 12) return null; // 13pm etc. is not a valid 12-hour clock time
      const meridiem = m[2].toLowerCase();
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
      return resolveClockReset(now, hour, 0, m[3]);
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
