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
 * Weekday name (full or common abbreviation) -> day-of-week index (0=Sunday).
 * Used by the weekday reset pattern. Kept ordered longest-first inside the
 * regex alternation so "thursday" wins over "thu".
 */
const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tues: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thurs: 4,
  thur: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/** Month name (full or 3-letter abbreviation) -> month index (0=January). */
const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sept: 8,
  sep: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

/**
 * Parses the "time of day" tail that can follow a weekday/date reset, e.g.
 * the "9am" in "resets on Monday at 9am" or the "14:30" in "reset on Nov 4 at
 * 14:30". Accepts `hh:mm[am|pm]`, `hh am|pm`, and the words `noon`/`midnight`.
 * Returns `{ hour, minute }` in 24-hour form, or `null` when the tail carries
 * no recognizable time — callers then fall back to midnight (start of day).
 */
function parseTimeOfDay(text: string | undefined): { hour: number; minute: number } | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (/^noon\b/i.test(trimmed)) return { hour: 12, minute: 0 };
  if (/^midnight\b/i.test(trimmed)) return { hour: 0, minute: 0 };

  const withMinutes = trimmed.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (withMinutes) {
    let hour = parseInt(withMinutes[1], 10);
    const minute = parseInt(withMinutes[2], 10);
    if (hour > 23 || minute > 59) return null;
    const meridiem = withMinutes[3]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    return { hour, minute };
  }

  const meridiemOnly = trimmed.match(/^(\d{1,2})\s*(am|pm)\b/i);
  if (meridiemOnly) {
    let hour = parseInt(meridiemOnly[1], 10);
    if (hour > 12) return null; // 13pm etc. is not a valid 12-hour clock time
    const meridiem = meridiemOnly[2].toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    return { hour, minute: 0 };
  }

  return null;
}

/**
 * The next future instant that falls on `targetDow` (0=Sunday) at `hour:minute`
 * local time, relative to `now`. If today already matches the weekday but the
 * time has passed (or is exactly now), it rolls forward a full week — a real
 * reset is always in the future, and for weekly limits "resets on Monday" seen
 * on a Monday afternoon means *next* Monday.
 */
function nextWeekday(now: Date, targetDow: number, hour: number, minute: number): Date {
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  const delta = (targetDow - candidate.getDay() + 7) % 7;
  candidate.setDate(candidate.getDate() + delta);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 7);
  }
  return candidate;
}

/**
 * The next future instant on `month` (0=January) `day` at `hour:minute` local
 * time, relative to `now`. Rolls to next year if the date has already passed
 * this year. Returns `null` for calendar-invalid dates (e.g. Feb 30, or Feb 29
 * when neither this year nor next is a leap year) — detected by checking that
 * the constructed Date didn't overflow into the following month.
 */
function nextMonthDay(now: Date, month: number, day: number, hour: number, minute: number): Date | null {
  if (day < 1 || day > 31) return null;
  for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
    const candidate = new Date(year, month, day, hour, minute, 0, 0);
    if (candidate.getMonth() !== month || candidate.getDate() !== day) continue; // overflowed => invalid date
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  return null;
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
    // "resets on Monday at 9am" / "reset Monday" / "your weekly limit will reset
    // on Wed at 14:30" — the weekday wording Claude Code uses for weekly usage
    // limits. Resolves to the next occurrence of that weekday; an optional
    // "at <time>" tail sets the hour, otherwise midnight (start of day) is
    // assumed (if that lands early, the relay just re-detects on the next run).
    // Placed before the clock-time patterns so "reset on Monday at 9am" is not
    // mis-parsed as "9am today/tomorrow" (which would ignore the weekday).
    // The named timezone in the message is interpreted as local time, the same
    // known limitation as the clock-time patterns.
    name: "weekday-date",
    regex:
      /reset[s]?\s+(?:on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)\b(?:\s+at\s+([^\r\n.,;]+))?/i,
    resolve: (m, now) => {
      const dow = WEEKDAYS[m[1].toLowerCase()];
      if (dow === undefined) return null;
      const time = parseTimeOfDay(m[2]) ?? { hour: 0, minute: 0 };
      return nextWeekday(now, dow, time.hour, time.minute);
    },
  },
  {
    // "resets on Nov 4 at 9am" / "reset on January 15" — a calendar date, used
    // by some agents for weekly/monthly windows. Resolves to the next future
    // occurrence of that month/day (this year, else next). An optional
    // "at <time>" tail sets the hour, otherwise midnight. Placed before the
    // clock-time patterns for the same reason as weekday-date.
    name: "month-day-date",
    regex:
      /reset[s]?\s+(?:on\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\s+(\d{1,2})(?:\s+at\s+([^\r\n.,;]+))?/i,
    resolve: (m, now) => {
      const month = MONTHS[m[1].toLowerCase()];
      if (month === undefined) return null;
      const day = parseInt(m[2], 10);
      const time = parseTimeOfDay(m[3]) ?? { hour: 0, minute: 0 };
      return nextMonthDay(now, month, day, time.hour, time.minute);
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
const LOOKS_LIKE_RATE_LIMIT =
  /(rate.?limit|usage limit|try again|resets?\s+(at|in|on|sun|mon|tue|wed|thu|fri|sat|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|retry.?after)/i;

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
