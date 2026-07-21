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
    // "try again in 4h32m" / "retry in 5 hours" / "resets in 45m" / "resets in 2h"
    name: "relative-duration",
    regex: /(?:try again|resets?|retry)\s+in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i,
    resolve: (m, now) => {
      const hours = m[1] ? parseInt(m[1], 10) : 0;
      const minutes = m[2] ? parseInt(m[2], 10) : 0;
      if (hours === 0 && minutes === 0) return null;
      return new Date(now.getTime() + (hours * 60 + minutes) * 60_000);
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
    // Weekly-limit messages that name a weekday and a time, e.g.
    // "resets on Monday at 9am", "reset Thursday at 14:00", "resets Wednesday 4pm".
    // The plain `clock-time` pattern only fires on "reset AT <time>" (no weekday
    // in between), so these day-of-week forms would otherwise be missed. Resolves
    // to the next occurrence of that weekday at the given local time.
    name: "weekday-clock",
    regex: /reset[s]?\s+(?:on\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
    resolve: (m, now) => resolveWeekday(m[1], m[2], m[3], m[4], now),
  },
  {
    // Weekday with no time, e.g. "resets Monday", "reset on Sunday". Lower
    // confidence — resolves to the next occurrence of that weekday at local
    // midnight. Kept after `weekday-clock` so a time, when present, wins.
    name: "weekday-only",
    regex: /reset[s]?\s+(?:on\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i,
    resolve: (m, now) => resolveWeekday(m[1], undefined, undefined, undefined, now),
  },
  {
    // Generic "5-hour limit" mention with no explicit time -> assume a full 5h window from now.
    // Kept last and treated as a low-confidence fallback.
    name: "five-hour-window-fallback",
    regex: /5[\s-]?hour(?:ly)?\s+(?:usage\s+)?limit/i,
    resolve: (_m, now) => new Date(now.getTime() + 5 * 60 * 60_000),
  },
];

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/**
 * Resolve a "reset on <weekday> [at <time>]" message to the next occurrence of
 * that weekday at the given local time (defaulting to midnight when no time is
 * present). Returns null for unknown weekdays or out-of-range clock values so
 * the parser falls through instead of emitting an invalid date.
 */
function resolveWeekday(
  weekday: string,
  hourRaw: string | undefined,
  minuteRaw: string | undefined,
  meridiemRaw: string | undefined,
  now: Date
): Date | null {
  const targetDow = WEEKDAY_INDEX[weekday.toLowerCase().slice(0, 3)];
  if (targetDow === undefined) return null;

  let hour = hourRaw ? parseInt(hourRaw, 10) : 0;
  const minute = minuteRaw ? parseInt(minuteRaw, 10) : 0;
  const meridiem = meridiemRaw?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;

  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  let dayDiff = (targetDow - candidate.getDay() + 7) % 7;
  // If it's the target weekday but the time already passed, roll to next week.
  if (dayDiff === 0 && candidate.getTime() <= now.getTime()) dayDiff = 7;
  candidate.setDate(candidate.getDate() + dayDiff);
  return candidate;
}

/** Quick pre-filter so we don't run every regex on every line of noisy CLI output. */
const LOOKS_LIKE_RATE_LIMIT =
  /(rate.?limit|usage limit|try again|resets?\s+(at|in|on|(?:mon|tue|wed|thu|fri|sat|sun))|retry_after)/i;

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
