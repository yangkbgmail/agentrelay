/**
 * Timezone-aware resolution of a wall-clock time (e.g. "5pm") that a rate-limit
 * message pins to a *named* zone — the wording Claude Code actually prints:
 *   "Claude usage limit reached. Your limit will reset at 5pm (America/New_York)."
 *
 * The parser's clock-time patterns historically interpreted such a time in the
 * *machine's local* timezone and ignored the named zone entirely (a documented
 * known limitation). On a UTC server watching an agent whose reset is quoted in
 * US Eastern time, that is a 4–5 hour error — the relay parks the job hours too
 * early (retrying into a still-active limit) or hours too late (idle capacity).
 * This module resolves the time in the message's *own* zone instead.
 *
 * Two zone forms are supported, both reliable without pulling in a tz-database
 * dependency (the repo keeps zero runtime deps by design):
 *   - IANA names ("America/New_York", "Europe/Paris"): resolved via the
 *     platform Intl timezone data (Node ships full ICU, so every zone is here).
 *   - Fixed UTC/GMT offsets ("UTC", "GMT", "UTC+2", "GMT-8", "UTC+05:30").
 *
 * Ambiguous abbreviations (PST, EST, CET, …) are deliberately NOT resolved:
 * they map to different offsets in different regions and Intl won't accept them,
 * so the parser keeps its safe local-time fallback for those. Everything here is
 * pure and deterministic given an injected `now`, so it is fully unit-testable.
 */

/** UTC/GMT with an optional fixed offset: `UTC`, `GMT`, `UTC+2`, `GMT-8`, `UTC+05:30`. */
const FIXED_OFFSET_RE = /^(?:UTC|GMT)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/i;

/**
 * Parse a fixed UTC/GMT offset token into minutes east of UTC, or `null` if the
 * token is not a UTC/GMT offset (e.g. an IANA name or garbage). A bare `UTC` /
 * `GMT` is offset 0. Offsets beyond the real-world ±14:00 range are rejected.
 */
export function parseFixedOffsetMinutes(token: string): number | null {
  const m = token.trim().match(FIXED_OFFSET_RE);
  if (!m) return null;
  if (m[1] === undefined) return 0; // bare UTC / GMT
  const sign = m[1] === "-" ? -1 : 1;
  const hours = Number.parseInt(m[2], 10);
  const minutes = m[3] ? Number.parseInt(m[3], 10) : 0;
  if (hours > 14 || minutes > 59) return null;
  const total = sign * (hours * 60 + minutes);
  return Math.abs(total) > 14 * 60 ? null : total;
}

/**
 * True when `token` is an IANA zone name the platform recognizes. Requires a
 * `/` (so a bare "America" or an abbreviation can't sneak through) and that
 * `Intl.DateTimeFormat` accepts it (which throws for unknown zones).
 */
export function isIanaZone(token: string): boolean {
  if (!token.includes("/")) return false;
  try {
    // Constructing with the zone throws RangeError for an unknown timeZone.
    new Intl.DateTimeFormat("en-US", { timeZone: token });
    return true;
  } catch {
    return false;
  }
}

interface ZoneClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

/** The wall-clock date/time an IANA zone shows at a given UTC instant, or null. */
function zoneClockAt(timeZone: string, instantMs: number): ZoneClock | null {
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
    const parts = dtf.formatToParts(new Date(instantMs));
    const pick = (type: string): number => {
      const p = parts.find((q) => q.type === type);
      return p ? Number.parseInt(p.value, 10) : Number.NaN;
    };
    const year = pick("year");
    const month = pick("month");
    const day = pick("day");
    // Some ICU builds render midnight as hour "24" under h23; normalize to 0.
    let hour = pick("hour");
    if (hour === 24) hour = 0;
    const minute = pick("minute");
    const second = pick("second");
    if ([year, month, day, hour, minute, second].some(Number.isNaN)) return null;
    return { year, month, day, hour, minute, second };
  } catch {
    return null;
  }
}

/** Offset (minutes east of UTC) an IANA zone has at a given UTC instant, or null. */
function ianaOffsetMinutesAt(timeZone: string, instantMs: number): number | null {
  const c = zoneClockAt(timeZone, instantMs);
  if (!c) return null;
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  return Math.round((asUtc - instantMs) / 60_000);
}

/**
 * Convert a wall-clock time in an IANA zone to a UTC instant (ms). Uses the
 * standard guess-and-correct technique (as date-fns-tz does): treat the wall
 * clock as if it were UTC, look up the zone's offset at that guessed instant,
 * apply it, then re-check the offset at the corrected instant in case we crossed
 * a DST boundary. `monthZero` is 0-based; day overflow (e.g. day 32) is
 * normalized by `Date.UTC`, which is how "roll to tomorrow" is expressed.
 */
function ianaWallToUtc(
  timeZone: string,
  year: number,
  monthZero: number,
  day: number,
  hour: number,
  minute: number
): number | null {
  const guess = Date.UTC(year, monthZero, day, hour, minute);
  const off1 = ianaOffsetMinutesAt(timeZone, guess);
  if (off1 === null) return null;
  const instant = guess - off1 * 60_000;
  const off2 = ianaOffsetMinutesAt(timeZone, instant);
  if (off2 === null) return null;
  return off2 === off1 ? instant : guess - off2 * 60_000;
}

/** Next instant at or after `now` whose wall clock in a fixed-offset zone is hour:minute. */
function nextInFixedOffset(hour: number, minute: number, now: Date, offsetMinutes: number): Date {
  const offMs = offsetMinutes * 60_000;
  // Shifting `now` by the offset makes its UTC fields read as the zone's wall clock.
  const shifted = new Date(now.getTime() + offMs);
  const y = shifted.getUTCFullYear();
  const mo = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  let candidate = Date.UTC(y, mo, d, hour, minute) - offMs;
  if (candidate <= now.getTime()) {
    candidate = Date.UTC(y, mo, d + 1, hour, minute) - offMs; // Date.UTC normalizes overflow
  }
  return new Date(candidate);
}

/** Next instant at or after `now` whose wall clock in an IANA zone is hour:minute. */
function nextInIana(hour: number, minute: number, now: Date, timeZone: string): Date | null {
  const clock = zoneClockAt(timeZone, now.getTime());
  if (!clock) return null;
  let candidate = ianaWallToUtc(timeZone, clock.year, clock.month - 1, clock.day, hour, minute);
  if (candidate === null) return null;
  if (candidate <= now.getTime()) {
    candidate = ianaWallToUtc(timeZone, clock.year, clock.month - 1, clock.day + 1, hour, minute);
    if (candidate === null) return null;
  }
  return new Date(candidate);
}

/**
 * Resolve `hour:minute` (24-hour) as the next future instant in the zone named
 * by `tzToken`, or `null` when the token names no zone we can resolve (an
 * abbreviation, a typo, an unknown name). `null` is the signal for the caller to
 * fall back to its local-time interpretation rather than treat the whole message
 * as unparsed. `tzToken` may still carry surrounding parentheses/whitespace from
 * the message, e.g. "(America/New_York)"; they are stripped here.
 */
export function resolveZonedClockTime(hour: number, minute: number, now: Date, tzToken: string): Date | null {
  const token = tzToken.trim().replace(/^\(+/, "").replace(/\)+$/, "").trim();
  if (token === "") return null;
  const fixed = parseFixedOffsetMinutes(token);
  if (fixed !== null) return nextInFixedOffset(hour, minute, now, fixed);
  if (isIanaZone(token)) return nextInIana(hour, minute, now, token);
  return null;
}
