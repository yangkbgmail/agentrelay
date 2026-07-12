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
}

interface Pattern {
  name: string;
  regex: RegExp;
  resolve: (match: RegExpMatchArray, now: Date) => Date | null;
}

/** Resolve an hour:minute (+ optional am/pm) to the next such wall-clock time. */
function resolveClockTime(hour: number, minute: number, meridiem: string | undefined, now: Date): Date {
  const m = meridiem?.toLowerCase();
  if (m === "pm" && hour < 12) hour += 12;
  if (m === "am" && hour === 12) hour = 0;
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

const PATTERNS: Pattern[] = [
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
    resolve: (m, now) => resolveClockTime(parseInt(m[1], 10), parseInt(m[2], 10), m[3], now),
  },
  {
    // Claude Code's real wording uses a whole-hour + meridiem with no minutes,
    // e.g. "Your limit will reset at 10am" / "resets at 3 PM".
    name: "clock-time-meridiem",
    regex: /reset[s]?\s+at\s+(\d{1,2})\s*(am|pm)\b/i,
    resolve: (m, now) => resolveClockTime(parseInt(m[1], 10), 0, m[2], now),
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
    // "please wait 30 minutes" / "wait 90 seconds" -- imperative wording some
    // providers use instead of "try again in ...".
    name: "please-wait",
    regex: /wait\s+(\d+)\s*(second|sec|minute|min|hour|hr)s?/i,
    resolve: (m, now) => {
      const value = parseInt(m[1], 10);
      if (value === 0) return null;
      const unit = m[2].toLowerCase();
      const ms = unit.startsWith("sec")
        ? value * 1000
        : unit.startsWith("hour") || unit === "hr"
          ? value * 60 * 60_000
          : value * 60_000;
      return new Date(now.getTime() + ms);
    },
  },
  {
    // Unix epoch embedded in structured error payloads, e.g. `retry_after=1752345600`
    // Accepts seconds (10 digits) or milliseconds (13 digits).
    name: "unix-epoch",
    regex: /retry_after[=:]\s*(\d{13}|\d{10})/i,
    resolve: (m) => {
      const digits = m[1];
      const value = parseInt(digits, 10);
      return new Date(digits.length === 13 ? value : value * 1000);
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
  /(rate.?limit|usage limit|try again|resets?\s+(at|in)|retry_after|wait\s+\d+\s*(?:second|sec|minute|min|hour|hr))/i;

export function parseRateLimitMessage(text: string, options: ParseOptions = {}): RateLimitInfo | null {
  if (!LOOKS_LIKE_RATE_LIMIT.test(text)) return null;
  const now = options.now ?? new Date();

  for (const pattern of PATTERNS) {
    const match = text.match(pattern.regex);
    if (!match) continue;
    const resetDate = pattern.resolve(match, now);
    if (!resetDate || Number.isNaN(resetDate.getTime())) continue;
    return {
      resetAt: resetDate.toISOString(),
      rawMatch: match[0],
      pattern: pattern.name,
    };
  }

  return null;
}
