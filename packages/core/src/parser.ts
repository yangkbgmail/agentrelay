import { parseDuration } from "./prune.js";
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
  /**
   * Plausibility guard: reject any parsed reset that lands more than this many
   * milliseconds *after* `now`. A misparse (wrong epoch units, a huge relative
   * duration, a bad timezone) can otherwise resolve to a reset days or years
   * out, silently parking a job forever — the exact "silent failure" class this
   * relay keeps guarding against. When a pattern's reset is implausibly far
   * out, it's skipped as if it hadn't matched, so the parser falls through to a
   * saner pattern or returns `null` (the caller then treats it as a normal
   * completion instead of a multi-year wait). Only the *future* side is bounded
   * — a reset in the past just means the limit already lifted, which is safe to
   * resume immediately. `undefined`/`null`/`<= 0` disables the guard (the
   * historical behavior), so existing callers are unaffected.
   */
  maxFutureMs?: number | null;
}

/**
 * Default upper bound for a plausible rate-limit reset: 8 days. Generous enough
 * to cover real weekly usage windows (Claude's longest published limit) with
 * margin, while still rejecting the wildly-out resets a misparse produces.
 */
export const DEFAULT_MAX_RESET_HORIZON_MS = 8 * 24 * 60 * 60_000;

/**
 * True when `resetAt` is close enough to `now` to be a believable rate-limit
 * reset. Only the future side is bounded (see {@link ParseOptions.maxFutureMs}).
 * A non-positive / non-finite / nullish `maxFutureMs` means "no guard" and
 * always returns `true`. Pure and side-effect free so callers and tests can use
 * it directly.
 */
export function isPlausibleReset(resetAt: Date, now: Date, maxFutureMs?: number | null): boolean {
  if (maxFutureMs === undefined || maxFutureMs === null || !Number.isFinite(maxFutureMs) || maxFutureMs <= 0) {
    return true;
  }
  return resetAt.getTime() <= now.getTime() + maxFutureMs;
}

/**
 * Resolve the reset horizon (ms) from `AGENTRELAY_MAX_RESET_HORIZON`. Unset →
 * {@link DEFAULT_MAX_RESET_HORIZON_MS}. An explicit `0`/`off`/`none`/`disabled`
 * (or any non-positive / unparseable duration) → `null`, meaning the guard is
 * disabled. Anything else is parsed as a duration (`25h`, `2d`, `90m`, …).
 */
export function maxResetHorizonMsFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.AGENTRELAY_MAX_RESET_HORIZON?.trim();
  if (raw === undefined || raw === "") return DEFAULT_MAX_RESET_HORIZON_MS;
  if (/^(0|off|none|disabled|no)$/i.test(raw)) return null;
  const parsed = parseDuration(raw);
  return parsed !== null && parsed > 0 ? parsed : null;
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
 * Day-of-week name -> `Date.getDay()` index (0 = Sunday … 6 = Saturday). Keyed
 * by the first three letters, which uniquely identify every weekday, so both
 * abbreviations ("mon", "tues", "thur") and full names ("monday", "thursday")
 * collapse to the same key via `slice(0, 3)`.
 */
const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

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
    // Day-of-week reset, e.g. "resets Monday at 9am", "try again on Friday at
    // 15:00", "available again next Tuesday", "come back Sunday". Weekly usage
    // windows often reset on a named weekday rather than a bare clock time, and
    // none of the patterns above catch a message that names a day. The weekday
    // may be abbreviated (mon/tues/thur) or full, optionally prefixed with
    // "on"/"next" (both treated as filler). An "at <time>" clause is optional;
    // without one the reset defaults to 00:00 (start of that day) — a slight
    // under-estimate is self-correcting (the job resumes, and if still limited
    // is simply re-queued), whereas over-waiting a full day is not. The reset
    // resolves to the *nearest future* occurrence of that weekday: "next"
    // included, since colloquial usage is inconsistent and the nearest instant
    // is always the safe choice for a relay. Local time; a named timezone in
    // the message is ignored, the same known limitation as the clock patterns.
    name: "weekday-clock",
    regex:
      /(?:reset[s]?|try again|retry|available(?:\s+again)?|come back)\s+(?:on\s+)?(?:next\s+)?(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i,
    resolve: (m, now) => {
      const target = WEEKDAY_INDEX[m[1].slice(0, 3).toLowerCase()];
      if (target === undefined) return null;
      let hour = 0;
      let minute = 0;
      if (m[2] !== undefined) {
        hour = parseInt(m[2], 10);
        minute = m[3] ? parseInt(m[3], 10) : 0;
        const meridiem = m[4]?.toLowerCase();
        if (meridiem === "pm" && hour < 12) hour += 12;
        if (meridiem === "am" && hour === 12) hour = 0;
        if (hour > 23 || minute > 59) return null;
      }
      const candidate = new Date(now);
      candidate.setHours(hour, minute, 0, 0);
      // Advance day-by-day to the first matching weekday strictly after `now`.
      // Bounded at 8 iterations (a full week plus margin) so a pathological
      // input can never spin.
      for (let i = 0; i < 8; i++) {
        if (candidate.getDay() === target && candidate.getTime() > now.getTime()) return candidate;
        candidate.setDate(candidate.getDate() + 1);
      }
      return null;
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
  /(rate.?limit|usage limit|try again|available\s+again|resets?\s+(at|in|(?:on\s+)?(?:next\s+)?(?:mon|tue|wed|thu|fri|sat|sun))|retry.?after)/i;

function tryPattern(
  pattern: RateLimitPattern,
  text: string,
  now: Date,
  maxFutureMs?: number | null
): RateLimitInfo | null {
  const match = text.match(pattern.regex);
  if (!match) return null;
  const resetDate = pattern.resolve(match, now);
  if (!resetDate || Number.isNaN(resetDate.getTime())) return null;
  // Drop an implausibly far-out reset so a misparse can't park a job forever;
  // the caller keeps scanning for a saner pattern (or gets `null`).
  if (!isPlausibleReset(resetDate, now, maxFutureMs)) return null;
  return {
    resetAt: resetDate.toISOString(),
    rawMatch: match[0],
    pattern: pattern.name,
  };
}

export function parseRateLimitMessage(text: string, options: ParseOptions = {}): RateLimitInfo | null {
  const now = options.now ?? new Date();
  const maxFutureMs = options.maxFutureMs;

  // Tool-specific patterns win over the generic ones and are tried even when
  // the text doesn't trip the generic pre-filter (a tool may phrase things its
  // own way, e.g. "please try again in 20s").
  for (const pattern of options.extraPatterns ?? []) {
    const hit = tryPattern(pattern, text, now, maxFutureMs);
    if (hit) return hit;
  }

  if (!LOOKS_LIKE_RATE_LIMIT.test(text)) return null;

  for (const pattern of PATTERNS) {
    const hit = tryPattern(pattern, text, now, maxFutureMs);
    if (hit) return hit;
  }

  return null;
}
