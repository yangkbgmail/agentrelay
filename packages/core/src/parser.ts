import { parseDuration } from "./prune.js";
import { normalizeTimeZone, zoneCalendarDate, zonedWallClockToUtc } from "./timezone.js";
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
 * Regex fragment that optionally captures a trailing timezone token after a
 * wall-clock time, e.g. "5pm (America/New_York)", "15:00 UTC". Matches an IANA
 * identifier (requires a `/`, so an ordinary trailing word can't be mistaken
 * for a zone) or the fixed `UTC`/`GMT`. Bare civil abbreviations (`PST`, `EST`)
 * are intentionally not captured — see `normalizeTimeZone`. Kept as a string so
 * each wall-clock pattern can append it and share the same capture semantics.
 */
const TZ_FRAGMENT = "(?:\\s*\\(?\\s*([A-Za-z]+\\/[A-Za-z_]+(?:\\/[A-Za-z_]+)*|UTC|GMT)\\s*\\)?)?";

type WallClockDayMode = "next-occurrence" | "today" | "tomorrow";

/**
 * Build the UTC instant for a wall-clock reset. When `tzToken` names a zone the
 * parser recognizes, the hour/minute are interpreted *in that zone* (fixing the
 * long-standing bug where a message's stated timezone was ignored and the hour
 * read as machine-local). Otherwise it falls back to the historical local-time
 * behavior, so messages without a zone are unaffected.
 *
 * `mode` controls day placement: `next-occurrence` uses today and rolls to
 * tomorrow when the time is already past (clock-time patterns); `today` and
 * `tomorrow` place it on that calendar day with no roll (relative-day pattern).
 */
function resolveWallClock(now: Date, mode: WallClockDayMode, hour: number, minute: number, tzToken?: string): Date {
  const tz = normalizeTimeZone(tzToken);
  if (tz) {
    const base = zoneCalendarDate(now, tz);
    const dayShift = mode === "tomorrow" ? 1 : 0;
    let candidate = zonedWallClockToUtc(
      { year: base.year, month: base.month, day: base.day + dayShift, hour, minute },
      tz
    );
    if (mode === "next-occurrence" && candidate.getTime() <= now.getTime()) {
      candidate = zonedWallClockToUtc({ year: base.year, month: base.month, day: base.day + 1, hour, minute }, tz);
    }
    return candidate;
  }
  const candidate = new Date(now);
  if (mode === "tomorrow") candidate.setDate(candidate.getDate() + 1);
  candidate.setHours(hour, minute, 0, 0);
  if (mode === "next-occurrence" && candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
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
    // "resets at 3:00pm" / "resets at 15:00" (assume today, or tomorrow if already past).
    // An optional trailing timezone ("15:00 UTC", "3:00pm (America/New_York)") is
    // honored when recognized; otherwise the hour is read in local time.
    name: "clock-time",
    regex: new RegExp(`reset[s]?\\s+at\\s+(\\d{1,2}):(\\d{2})\\s*(am|pm)?${TZ_FRAGMENT}`, "i"),
    resolve: (m, now) => {
      let hour = parseInt(m[1], 10);
      const minute = parseInt(m[2], 10);
      const meridiem = m[3]?.toLowerCase();
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
      return resolveWallClock(now, "next-occurrence", hour, minute, m[4]);
    },
  },
  {
    // "resets at 5pm" / "reset at 10 AM" — hour + meridiem with NO minutes.
    // This is the wording Claude Code actually prints ("Your limit will reset
    // at 5pm (America/New_York)."), which the minute-requiring clock-time
    // pattern above misses. Meridiem is required: a bare "reset at 5" (no
    // colon, no am/pm) is too ambiguous to treat as a clock time. A named
    // timezone in the message ("(America/New_York)", "UTC") is now honored: the
    // hour is interpreted in that zone. Without a recognized zone the hour is
    // read in local time (historical behavior). A real reset is a future
    // instant, so rolling to tomorrow when already past keeps us safe.
    name: "clock-time-meridiem",
    regex: new RegExp(`reset[s]?\\s+at\\s+(\\d{1,2})\\s*(am|pm)\\b${TZ_FRAGMENT}`, "i"),
    resolve: (m, now) => {
      let hour = parseInt(m[1], 10);
      if (hour > 12) return null; // 13pm etc. is not a valid 12-hour clock time
      const meridiem = m[2].toLowerCase();
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
      return resolveWallClock(now, "next-occurrence", hour, 0, m[3]);
    },
  },
  {
    // Relative-day wording: "resets tomorrow at 9am" / "try again tomorrow" /
    // "come back today at 5pm" / "your limit resets tomorrow". Real agent CLIs
    // phrase a reset this way, and none of the other patterns catch it: the
    // clock-time ones need an adjacent "reset at <time>" (here the day word sits
    // between), and relative-duration needs "in". Without this the message
    // silently produces no detection and the job never resumes.
    //
    // The reset trigger word must be adjacent to the day word so an incidental
    // "tomorrow" elsewhere in noisy output isn't misread as a reset time.
    //
    // Time resolution (local time by default; a recognized trailing timezone —
    // "tomorrow at 9am UTC", "today at 5pm (America/New_York)" — is honored):
    //   - "<day> at 9am" / "at 9:30pm" -> that 12-hour clock time on that day
    //   - "<day> at 15:00" / "at 21"   -> that 24-hour clock time on that day
    //   - "tomorrow" (no time)         -> midnight (00:00) starting tomorrow
    //   - "today" (no time)            -> skipped (null): "sometime today" has no
    //                                     defensible instant, so guessing one
    //                                     risks a wrong wait.
    name: "relative-day",
    regex: new RegExp(
      `(?:reset[s]?|try again|retry|come back|available)\\s+(?:on\\s+)?(today|tomorrow)\\b(?:\\s+at\\s+(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?)?${TZ_FRAGMENT}`,
      "i"
    ),
    resolve: (m, now) => {
      const isTomorrow = m[1].toLowerCase() === "tomorrow";
      const hasTime = m[2] !== undefined;
      const tzToken = m[5];
      const mode: WallClockDayMode = isTomorrow ? "tomorrow" : "today";

      if (!hasTime) {
        // "today" with no time is too vague to place on the clock; only
        // "tomorrow" gets a defensible instant (the start of that day).
        if (!isTomorrow) return null;
        return resolveWallClock(now, "tomorrow", 0, 0, tzToken);
      }

      let hour = parseInt(m[2], 10);
      const minute = m[3] !== undefined ? parseInt(m[3], 10) : 0;
      const meridiem = m[4]?.toLowerCase();
      if (meridiem) {
        if (hour < 1 || hour > 12) return null; // invalid 12-hour clock time
        if (meridiem === "pm" && hour < 12) hour += 12;
        if (meridiem === "am" && hour === 12) hour = 0;
      } else if (hour > 23) {
        return null; // invalid 24-hour clock time
      }
      if (minute > 59) return null;
      return resolveWallClock(now, mode, hour, minute, tzToken);
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
    // A Unix epoch embedded in a structured error payload, under `retry_after`
    // or a `reset_at` / `resetAt` / `resets_at` field, e.g. `retry_after=1752345600`,
    // `"retry_after": 1752345600`, `"reset_at": 1752345600`, or `resetAt: 1752345600000`.
    // Normally 10-digit *seconds*, but some payloads carry a 13-digit *millisecond*
    // epoch straight from `Date.now()`; both widths are accepted and disambiguated
    // by digit count. The `\b` boundary rejects ambiguous 11/12-digit values (neither
    // clean seconds nor clean ms) so a misparse can't resume a job at a wild time.
    name: "unix-epoch",
    regex: /(?:retry_after|resets?_?at)"?\s*[=:]\s*(\d{13}|\d{10})\b/i,
    resolve: (m) => {
      const digits = m[1];
      const value = parseInt(digits, 10);
      if (!Number.isFinite(value)) return null;
      const ms = digits.length === 13 ? value : value * 1000;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    },
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
  /(rate.?limit|usage limit|try again|resets?\s+(at|in)|resets?_?at\s*[=:]|retry.?after|(?:try again|retry|come back|available|resets?)\s+(?:on\s+)?to(?:day|morrow))/i;

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
