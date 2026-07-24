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
 * Returns the offset (in ms) between the given IANA time zone's wall clock and
 * UTC at a specific instant, i.e. `zoneWallTimeAsIfUTC - instant`. Positive east
 * of UTC. Returns null if the runtime doesn't recognize `timeZone`.
 *
 * DST-safe because it evaluates the offset at a concrete instant rather than
 * assuming a fixed offset for the zone.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number | null {
  try {
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
    const parts = dtf.formatToParts(instant);
    const map: Record<string, number> = {};
    for (const p of parts) {
      if (p.type !== "literal") map[p.type] = parseInt(p.value, 10);
    }
    const asUTC = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
    return asUTC - instant.getTime();
  } catch {
    // RangeError for an unknown/invalid time zone identifier.
    return null;
  }
}

/**
 * Converts a wall-clock date/time *as read in `timeZone`* into the UTC instant
 * it denotes. Two-pass offset correction handles DST boundaries: the offset can
 * differ between the UTC-naive guess and the real instant, so we recompute once.
 * Returns null if the zone is unknown.
 */
function wallTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date | null {
  const guessUTC = Date.UTC(year, month - 1, day, hour, minute, 0);
  const off1 = zoneOffsetMs(new Date(guessUTC), timeZone);
  if (off1 === null) return null;
  const off2 = zoneOffsetMs(new Date(guessUTC - off1), timeZone);
  if (off2 === null) return null;
  return new Date(guessUTC - off2);
}

/**
 * The next instant at or after `now` whose wall clock in `timeZone` reads
 * `hour:minute`. Rolls to the following calendar day (in that zone) when today's
 * occurrence has already passed. Returns null if the zone is unrecognized so the
 * caller can fall back to local-time interpretation.
 */
export function resolveClockTimeInZone(hour: number, minute: number, now: Date, timeZone: string): Date | null {
  const offNow = zoneOffsetMs(now, timeZone);
  if (offNow === null) return null;
  // Shift `now` by the zone offset so its getUTC* accessors read as the zone's
  // wall clock — a cheap way to learn today's calendar date in that zone.
  const nowInZone = new Date(now.getTime() + offNow);
  let candidate = wallTimeToInstant(
    nowInZone.getUTCFullYear(),
    nowInZone.getUTCMonth() + 1,
    nowInZone.getUTCDate(),
    hour,
    minute,
    timeZone
  );
  if (!candidate) return null;
  if (candidate.getTime() <= now.getTime()) {
    const nextDay = new Date(nowInZone.getTime() + 24 * 60 * 60_000);
    candidate = wallTimeToInstant(
      nextDay.getUTCFullYear(),
      nextDay.getUTCMonth() + 1,
      nextDay.getUTCDate(),
      hour,
      minute,
      timeZone
    );
    if (!candidate) return null;
  }
  return candidate;
}

/** Local-time clock resolution: the historic behavior, kept as the fallback. */
function resolveClockTimeLocal(hour: number, minute: number, now: Date): Date {
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

/**
 * Resolves a clock time to a future instant, honoring an IANA `timeZone` when
 * one was named in the message (e.g. "reset at 5pm (America/New_York)"). Falls
 * back to local-time interpretation when the zone is absent or unrecognized, so
 * behavior never regresses relative to the timezone-blind version.
 */
function resolveClockTime(hour: number, minute: number, now: Date, timeZone?: string): Date {
  if (timeZone) {
    const zoned = resolveClockTimeInZone(hour, minute, now, timeZone);
    if (zoned) return zoned;
  }
  return resolveClockTimeLocal(hour, minute, now);
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
    // An optional IANA time zone in parentheses — "resets at 3:00pm (America/New_York)" —
    // is honored so the reset instant is correct regardless of where the daemon runs.
    name: "clock-time",
    regex: /reset[s]?\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)?(?:\s*\(([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)\))?/i,
    resolve: (m, now) => {
      let hour = parseInt(m[1], 10);
      const minute = parseInt(m[2], 10);
      const meridiem = m[3]?.toLowerCase();
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
      return resolveClockTime(hour, minute, now, m[4]);
    },
  },
  {
    // "resets at 5pm" / "reset at 10 AM" — hour + meridiem with NO minutes.
    // This is the wording Claude Code actually prints ("Your limit will reset
    // at 5pm (America/New_York)."), which the minute-requiring clock-time
    // pattern above misses. Meridiem is required: a bare "reset at 5" (no
    // colon, no am/pm) is too ambiguous to treat as a clock time. A named IANA
    // time zone in parentheses is now honored (see resolveClockTime): the hour
    // is interpreted in that zone when recognized, else it falls back to local
    // time (a real reset is a future instant, so rolling to tomorrow when
    // already past keeps us safe either way).
    name: "clock-time-meridiem",
    regex: /reset[s]?\s+at\s+(\d{1,2})\s*(am|pm)\b(?:\s*\(([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)\))?/i,
    resolve: (m, now) => {
      let hour = parseInt(m[1], 10);
      if (hour > 12) return null; // 13pm etc. is not a valid 12-hour clock time
      const meridiem = m[2].toLowerCase();
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
      return resolveClockTime(hour, 0, now, m[3]);
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
    // Generic "5-hour limit" mention with no explicit time -> assume a full 5h window from now.
    // Kept last and treated as a low-confidence fallback.
    name: "five-hour-window-fallback",
    regex: /5[\s-]?hour(?:ly)?\s+(?:usage\s+)?limit/i,
    resolve: (_m, now) => new Date(now.getTime() + 5 * 60 * 60_000),
  },
];

/** Quick pre-filter so we don't run every regex on every line of noisy CLI output. */
const LOOKS_LIKE_RATE_LIMIT = /(rate.?limit|usage limit|try again|resets?\s+(at|in)|retry_after)/i;

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
