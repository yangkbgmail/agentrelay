/**
 * Timezone-aware resolution of wall-clock reset times.
 *
 * The `clock-time` / `clock-time-meridiem` parser patterns previously
 * interpreted an hour like "5pm" in the *local* time of whatever machine ran
 * AgentRelay, ignoring any timezone the message named. But the real wording
 * Claude Code prints is timezone-qualified — e.g.
 *
 *     Your limit will reset at 5pm (America/New_York).
 *
 * For a user whose machine is in, say, UTC+9, interpreting that "5pm" locally
 * puts the reset ~13-14 hours off — a serious error for a tool whose whole job
 * is to resume *at* the reset. This module resolves the named zone correctly
 * using `Intl.DateTimeFormat`, which ships real IANA/DST data with Node, so no
 * dependency is added (consistent with the zero-dependency store decision).
 *
 * Only IANA zone names ("America/New_York", "Asia/Seoul", …) and the fixed
 * "UTC"/"GMT" aliases are supported. Bare abbreviations like "PST"/"EST" are
 * deliberately *not* handled: they are ambiguous (PST vs. PDT, and several
 * countries reuse the same abbreviation) and `Intl` rejects most of them. When
 * a zone is unrecognized we return `null` so the caller can fall back to the
 * previous local-time behavior rather than guessing wrong.
 */

/**
 * Offset (target-zone wall clock minus UTC) in milliseconds at `instant`.
 * Positive east of UTC. Throws `RangeError` if `timeZone` is not a zone `Intl`
 * recognizes — callers should treat that as "unknown zone".
 */
function zoneOffsetMs(timeZone: string, instant: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  // `Intl` renders midnight as hour "24" in some engines; normalize to 0.
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const wallAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  return wallAsUtc - instant.getTime();
}

/**
 * The UTC instant at which the wall clock in `timeZone` reads
 * `year-month-day hour:minute` (seconds 0). Resolves the zone offset with a
 * two-pass correction so DST transitions land on the right side. Returns `null`
 * if the zone is unrecognized.
 */
function wallTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date | null {
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let offset: number;
  try {
    offset = zoneOffsetMs(timeZone, new Date(guessUtc));
  } catch {
    return null; // unknown zone
  }
  let instant = guessUtc - offset;
  // Re-measure the offset *at* the computed instant; near a DST boundary the
  // first guess can straddle the transition and be off by an hour.
  const settled = zoneOffsetMs(timeZone, new Date(instant));
  if (settled !== offset) instant = guessUtc - settled;
  return new Date(instant);
}

/** The calendar date (in `timeZone`) that `now` falls on. */
function zonedCalendarDate(now: Date, timeZone: string): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(now)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/**
 * The next future instant at which the wall clock in `timeZone` reads
 * `hour:minute`. Mirrors the local-time patterns' "roll to tomorrow if the
 * time already passed today" rule, but anchored to the named zone's calendar
 * and offset. Returns `null` when `timeZone` is unrecognized so the caller can
 * fall back to local interpretation.
 */
export function nextZonedClockTime(now: Date, hour: number, minute: number, timeZone: string): Date | null {
  const zone = normalizeZone(timeZone);
  if (zone === null) return null;

  let year: number;
  let month: number;
  let day: number;
  try {
    ({ year, month, day } = zonedCalendarDate(now, zone));
  } catch {
    return null; // zone contained a "/" but isn't a real IANA name
  }
  let instant = wallTimeToInstant(year, month, day, hour, minute, zone);
  if (instant === null) return null; // unknown zone

  if (instant.getTime() <= now.getTime()) {
    // Advance one calendar day in the target zone. Stepping the UTC-midnight of
    // the zone's date by 24h and re-reading the components handles month/year
    // boundaries without a local-time detour.
    const nextDay = new Date(Date.UTC(year, month - 1, day) + 86_400_000);
    instant = wallTimeToInstant(
      nextDay.getUTCFullYear(),
      nextDay.getUTCMonth() + 1,
      nextDay.getUTCDate(),
      hour,
      minute,
      zone,
    );
  }
  return instant;
}

/**
 * Canonicalizes a zone token captured from a message. Accepts IANA names
 * (containing a "/") and the "UTC"/"GMT" aliases (case-insensitively, mapped to
 * "UTC"). Returns `null` for anything else — including ambiguous abbreviations
 * like "PST" — so the parser falls back to local time instead of guessing.
 */
export function normalizeZone(token: string): string | null {
  const trimmed = token.trim();
  const upper = trimmed.toUpperCase();
  if (upper === "UTC" || upper === "GMT") return "UTC";
  // IANA zone names always contain a region/city separator.
  if (trimmed.includes("/")) return trimmed;
  return null;
}
