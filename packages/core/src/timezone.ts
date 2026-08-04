/**
 * Timezone helpers for clock-time rate-limit messages that *name* the timezone
 * their reset time is stated in, e.g. Claude Code's real wording
 * "Your limit will reset at 5pm (America/New_York)."
 *
 * Without this, the parser interprets the bare hour in the *host machine's*
 * local time. That is only correct when the host happens to share the reported
 * zone; otherwise the computed reset instant is off by the whole zone gap, so
 * the relay resumes hours too early (and immediately hits the limit again) or
 * hours too late (wasted idle time). This module lets the parser honor the
 * zone that the message actually states.
 *
 * Everything here is pure and clock-injectable so it stays deterministic in
 * tests regardless of the machine's own timezone. Zone data comes from the
 * platform ICU (`Intl`), which Node ships with by default — no dependency.
 */

/**
 * A recognized timezone: either a fixed UTC offset (from `UTC+9`, `GMT-5`,
 * `+05:30`, `Z`) or a named IANA zone (`America/New_York`, `Asia/Seoul`) whose
 * offset — including DST — is resolved against the platform's zone database.
 */
export type ParsedZone = { kind: "offset"; offsetMinutes: number } | { kind: "iana"; name: string };

/**
 * Parse a timezone token pulled out of a reset message. Recognizes:
 *   - Fixed offsets: `UTC+9`, `GMT-05:00`, `+0530`, `-8`, and bare `UTC`/`GMT`/`Z` (=0).
 *   - IANA zone names validated against the platform zone database.
 * Returns null for anything unrecognized so the caller can fall back to the
 * existing local-time interpretation rather than guess.
 */
export function parseZoneToken(token: string): ParsedZone | null {
  const t = token.trim();
  if (!t) return null;

  // `Z` and bare `UTC`/`GMT` are exactly UTC.
  if (/^(?:utc|gmt|z)$/i.test(t)) return { kind: "offset", offsetMinutes: 0 };

  // Fixed offset, optionally prefixed with UTC/GMT: `UTC+9`, `GMT-05:00`, `+0530`, `-8`.
  const offset = t.match(/^(?:utc|gmt)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (offset) {
    const sign = offset[1] === "-" ? -1 : 1;
    const hours = Number.parseInt(offset[2], 10);
    const minutes = offset[3] ? Number.parseInt(offset[3], 10) : 0;
    // Real UTC offsets span roughly [-12, +14]; minutes < 60. Reject the rest.
    if (hours > 14 || minutes > 59) return null;
    return { kind: "offset", offsetMinutes: sign * (hours * 60 + minutes) };
  }

  // Otherwise treat it as an IANA name and let the platform validate it.
  if (isValidIanaZone(t)) return { kind: "iana", name: t };
  return null;
}

/** True when `name` is a timezone the platform's `Intl` recognizes. */
export function isValidIanaZone(name: string): boolean {
  try {
    // Throws RangeError for an unknown timeZone; valid ones construct fine.
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * Offset in minutes (zone-local wall clock minus UTC) of an IANA zone at a
 * specific instant. Returns null if the zone can't be read. Positive east of
 * UTC (e.g. Asia/Seoul → +540), negative west (America/New_York → -240/-300).
 */
export function ianaOffsetMinutes(timeZone: string, at: Date): number | null {
  let parts: Intl.DateTimeFormatPart[];
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
    parts = dtf.formatToParts(at);
  } catch {
    return null;
  }
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number.parseInt(parts.find((p) => p.type === type)?.value ?? "", 10);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  // `hourCycle: h23` still emits "24" at midnight in some ICU builds; fold to 0.
  const hour = get("hour") % 24;
  const minute = get("minute");
  const second = get("second");
  if ([year, month, day, hour, minute, second].some((n) => Number.isNaN(n))) return null;
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return Math.round((asIfUtc - at.getTime()) / 60_000);
}

/**
 * Convert a wall-clock date+time *in a zone* to the corresponding UTC instant.
 * For IANA zones this does a two-pass offset resolution so instants near a DST
 * transition land on the correct side. Returns null if the zone can't be read.
 */
function zonedFieldsToUtc(
  zone: ParsedZone,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): Date | null {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  if (zone.kind === "offset") {
    return new Date(asIfUtc - zone.offsetMinutes * 60_000);
  }
  const off1 = ianaOffsetMinutes(zone.name, new Date(asIfUtc));
  if (off1 === null) return null;
  let ts = asIfUtc - off1 * 60_000;
  // Re-resolve at the candidate instant: the offset can differ across a DST
  // boundary from the offset at the naive-UTC guess.
  const off2 = ianaOffsetMinutes(zone.name, new Date(ts));
  if (off2 !== null && off2 !== off1) ts = asIfUtc - off2 * 60_000;
  return new Date(ts);
}

/** The calendar date (year/month/day) that `at` falls on within `zone`. */
function zoneCalendarDate(zone: ParsedZone, at: Date): { year: number; month: number; day: number } | null {
  if (zone.kind === "offset") {
    const shifted = new Date(at.getTime() + zone.offsetMinutes * 60_000);
    return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
  }
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone.name,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(at);
  } catch {
    return null;
  }
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number.parseInt(parts.find((p) => p.type === type)?.value ?? "", 10);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  if ([year, month, day].some((n) => Number.isNaN(n))) return null;
  return { year, month, day };
}

/**
 * Next occurrence of wall-clock `hour:minute` in `zone` strictly after `now`.
 * Uses the zone's *own* calendar day: today's time if it's still ahead, else
 * the same time tomorrow. Returns null if the zone can't be resolved.
 */
export function nextClockTimeInZone(zone: ParsedZone, hour: number, minute: number, now: Date): Date | null {
  const today = zoneCalendarDate(zone, now);
  if (!today) return null;

  let candidate = zonedFieldsToUtc(zone, today.year, today.month, today.day, hour, minute);
  if (!candidate) return null;

  if (candidate.getTime() <= now.getTime()) {
    // Advance one calendar day within the zone, then rebuild (so the offset is
    // re-derived — the target day may sit on the other side of a DST switch).
    const next = new Date(Date.UTC(today.year, today.month - 1, today.day));
    next.setUTCDate(next.getUTCDate() + 1);
    candidate = zonedFieldsToUtc(zone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hour, minute);
    if (!candidate) return null;
  }
  return candidate;
}
