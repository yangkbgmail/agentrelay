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

/** Parse an explicit ISO-8601 timestamp; null if it isn't a valid date. */
function resolveIsoTimestamp(raw: string): Date | null {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The next future instant matching a wall-clock `hour:minute` (local time).
 * If that time already passed today, roll to tomorrow — a reset is always a
 * future instant, so rolling forward keeps us from resuming a whole day early.
 */
function nextClockInstant(hour: number, minute: number, now: Date): Date {
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

/** Apply 12-hour meridiem (am/pm) to a bare hour: 12am -> 0, 12pm -> 12. */
function applyMeridiem(hour: number, meridiem: string | undefined): number {
  const m = meridiem?.toLowerCase();
  if (m === "pm" && hour < 12) return hour + 12;
  if (m === "am" && hour === 12) return 0;
  return hour;
}

const PATTERNS: RateLimitPattern[] = [
  {
    // "reset at 2026-07-13T05:00:00Z" or similar explicit ISO timestamps
    name: "iso-timestamp",
    regex: /reset[s]?\s+at\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i,
    resolve: (m) => resolveIsoTimestamp(m[1]),
  },
  {
    // "resets at 3:00pm" / "resets at 15:00" (assume today, or tomorrow if already past)
    name: "clock-time",
    regex: /reset[s]?\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i,
    resolve: (m, now) => nextClockInstant(applyMeridiem(parseInt(m[1], 10), m[3]), parseInt(m[2], 10), now),
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
      const hour = parseInt(m[1], 10);
      if (hour > 12) return null; // 13pm etc. is not a valid 12-hour clock time
      return nextClockInstant(applyMeridiem(hour, m[2]), 0, now);
    },
  },
  {
    // "rate limited until 2026-07-13T05:00:00Z" — an explicit ISO reset after
    // the "until" preposition. Some agent CLIs / APIs phrase the cooldown as a
    // deadline ("limited until <when>") rather than "reset at <when>". Ordered
    // before the until-clock patterns so an ISO timestamp isn't partially
    // matched as a bare clock time. The generic pre-filter only lets these run
    // when a limit word precedes "until", so plain English "until 5pm" in
    // unrelated output won't be misread as a reset.
    name: "until-iso-timestamp",
    regex: /until\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i,
    resolve: (m) => resolveIsoTimestamp(m[1]),
  },
  {
    // "limited until 3:00pm" / "blocked until 15:00" — wall-clock deadline.
    name: "until-clock-time",
    regex: /until\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i,
    resolve: (m, now) => nextClockInstant(applyMeridiem(parseInt(m[1], 10), m[3]), parseInt(m[2], 10), now),
  },
  {
    // "limited until 5pm" / "locked until 10 AM" — hour + meridiem, no minutes.
    name: "until-clock-meridiem",
    regex: /until\s+(\d{1,2})\s*(am|pm)\b/i,
    resolve: (m, now) => {
      const hour = parseInt(m[1], 10);
      if (hour > 12) return null; // 13pm etc. is not a valid 12-hour clock time
      return nextClockInstant(applyMeridiem(hour, m[2]), 0, now);
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

/**
 * Quick pre-filter so we don't run every regex on every line of noisy CLI output.
 * The `until` clause is deliberately gated behind a limit-y word within a short
 * span before it — "until" alone is far too common in ordinary English to treat
 * as a rate-limit signal, so a bare "wait until 10:30 for the meeting" won't trip
 * the parser, while "you are rate limited until 3pm" does.
 */
const LOOKS_LIKE_RATE_LIMIT =
  /(rate.?limit|usage limit|try again|resets?\s+(at|in)|retry.?after|(?:limit|limited|quota|blocked|locked|throttl|cooldown|unavailable|paused|suspended)[^\n]{0,40}?until\b)/i;

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
