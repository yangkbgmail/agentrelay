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
  {
    // Claude's plans carry a rolling *weekly* usage limit alongside the 5-hour
    // window (introduced 2025). When that limit trips and the message carries no
    // explicit reset time (e.g. "You've reached your weekly limit"), fall back to
    // a full 7-day window from now — the conservative bound that never resumes
    // too early, mirroring the 5-hour fallback's rationale. Kept after the
    // 5-hour fallback and last overall: lowest confidence, reached only when no
    // explicit reset time matched. A message that *does* spell out the reset
    // (an ISO stamp, a clock time, "resets in 2d 4h") matches an earlier,
    // higher-confidence pattern first, so this only fires for the timeless case.
    // 7d stays under DEFAULT_MAX_RESET_HORIZON_MS (8d), so the plausibility guard
    // keeps it rather than dropping it as a misparse.
    name: "weekly-window-fallback",
    regex: /weekly\s+(?:usage\s+|rate\s+)?limit/i,
    resolve: (_m, now) => new Date(now.getTime() + 7 * 24 * 60 * 60_000),
  },
];

/** Quick pre-filter so we don't run every regex on every line of noisy CLI output. */
const LOOKS_LIKE_RATE_LIMIT =
  /(rate.?limit|usage limit|weekly\s+(?:usage\s+|rate\s+)?limit|try again|resets?\s+(at|in)|retry.?after)/i;

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
