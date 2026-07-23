/**
 * Timezone-aware wall-clock resolution for the rate-limit parser.
 *
 * Claude Code prints wording like "Your limit will reset at 5pm
 * (America/New_York)." The clock-time patterns historically interpreted that
 * hour in the *local* machine timezone, which produces the wrong resume
 * instant whenever the machine runs in a different zone than the one the agent
 * reports (e.g. a server in UTC parsing an America/New_York reset would resume
 * hours early or late). These helpers convert a wall-clock time in a named
 * IANA timezone to the correct absolute UTC instant using only the built-in
 * `Intl` APIs — full ICU ships with Node >= 22, so no dependency is needed.
 *
 * The approach is the well-known "guess as UTC, then correct by the zone
 * offset" trick, applied twice so a reset that lands near a DST transition
 * still resolves to the right side of the jump in the common case.
 */

/** True if `timeZone` is an IANA zone this runtime recognizes (e.g. "America/New_York", "UTC"). */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    // Constructing with an unknown timeZone throws RangeError.
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a token pulled from a rate-limit message should be trusted as a
 * timezone. We accept only unambiguous IANA "Area/Location" names — the form
 * Claude Code prints, e.g. "(America/New_York)" — plus "UTC"/"GMT". Bare
 * abbreviations like "PST"/"EST" are deliberately rejected even when the
 * runtime happens to accept them: ICU maps them inconsistently ("PST" ->
 * America/Los_Angeles, which observes DST; "EST" -> America/Panama, a fixed
 * UTC-5), so guessing wrong is worse than falling back to local time.
 */
export function isNamedTimeZone(token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  const upper = t.toUpperCase();
  if (upper === "UTC" || upper === "GMT") return true;
  if (!t.includes("/")) return false;
  return isValidTimeZone(t);
}

/**
 * The `timeZone`'s UTC offset in milliseconds at `date`
 * (positive east of UTC, e.g. +9h for Asia/Seoul), or null if the zone is
 * invalid. Computed by formatting `date` in the zone and reading back the
 * wall-clock components as if they were UTC.
 */
export function timeZoneOffsetMs(timeZone: string, date: Date): number | null {
  const parts = zonedParts(timeZone, date);
  if (!parts) return null;
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Calendar/wall-clock components of `date` as seen in `timeZone`, or null if invalid. */
function zonedParts(timeZone: string, date: Date): ZonedParts | null {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const map: Record<string, string> = {};
    for (const part of dtf.formatToParts(date)) {
      if (part.type !== "literal") map[part.type] = part.value;
    }
    let hour = Number(map.hour);
    // Some ICU versions emit "24" for midnight in hour12:false formatting.
    if (hour === 24) hour = 0;
    const parts: ZonedParts = {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour,
      minute: Number(map.minute),
      second: Number(map.second),
    };
    if (Object.values(parts).some(Number.isNaN)) return null;
    return parts;
  } catch {
    return null;
  }
}

/** Absolute instant for wall-clock Y/M/D H:M in `timeZone` (day overflow normalized), or null. */
function instantForZonedWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date | null {
  // Treat the wall clock as if it were UTC, then subtract the zone's offset to
  // land on the true instant. Re-run the offset lookup at the corrected instant
  // so a value near a DST boundary settles on the right side of the jump.
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offset1 = timeZoneOffsetMs(timeZone, new Date(naiveUtc));
  if (offset1 === null) return null;
  const corrected = naiveUtc - offset1;
  const offset2 = timeZoneOffsetMs(timeZone, new Date(corrected));
  if (offset2 === null) return null;
  return new Date(naiveUtc - offset2);
}

/**
 * The next instant at which the wall clock reads `hour:minute` in `timeZone`,
 * on or after `now`. Uses the same "already past -> tomorrow" rule as the
 * local clock-time path so both resolve to a future reset. Returns null if the
 * zone is invalid so the caller can fall back to local interpretation.
 */
export function nextWallClockInZone(now: Date, hour: number, minute: number, timeZone: string): Date | null {
  const today = zonedParts(timeZone, now);
  if (!today) return null;
  const sameDay = instantForZonedWallClock(today.year, today.month, today.day, hour, minute, timeZone);
  if (!sameDay) return null;
  if (sameDay.getTime() > now.getTime()) return sameDay;
  // Already past in the zone — roll to the next calendar day (Date.UTC
  // normalizes month/year overflow when day+1 spills over).
  return instantForZonedWallClock(today.year, today.month, today.day + 1, hour, minute, timeZone);
}
