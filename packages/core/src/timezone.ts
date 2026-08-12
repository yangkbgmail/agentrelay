/**
 * Dependency-free helpers for interpreting a wall-clock time in a *named* IANA
 * timezone (e.g. "America/New_York") as an absolute UTC instant.
 *
 * Why this exists: agent CLIs print reset times in their account's timezone,
 * e.g. Claude Code's "Your limit will reset at 5pm (America/New_York)." The
 * parser used to ignore the named zone and interpret the hour in the *local*
 * timezone of the machine running agentrelay — which is wrong for anyone not
 * physically in that zone (a KST user would compute a reset 13-14 hours off).
 * These helpers close that gap using only `Intl.DateTimeFormat`, which ships
 * with Node and validates zone names for free (it throws on an unknown zone).
 *
 * All functions are pure: they take an explicit `at`/`now` instant and never
 * consult the process clock or the machine's local timezone, so they are fully
 * deterministic regardless of the `TZ` the test/host runs under.
 */

/**
 * The signed offset, in milliseconds, of `timeZone` from UTC at the instant
 * `at` (positive east of UTC — e.g. Asia/Seoul = +9h → +32_400_000; New York in
 * summer = -4h → -14_400_000). Returns `null` if `timeZone` is not a valid IANA
 * zone name, so callers can fall back to local-time behavior instead of throwing.
 *
 * Works by asking Intl for the zone's wall-clock breakdown of `at`, reading it
 * back as if it were UTC, and diffing against `at` — the standard technique for
 * recovering a zone offset without a timezone database dependency.
 */
export function zoneOffsetMs(timeZone: string, at: Date): number | null {
  if (Number.isNaN(at.getTime())) return null;
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
    // Invalid/unknown timeZone -> RangeError from the Intl constructor.
    return null;
  }
  const field: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") field[p.type] = Number(p.value);
  }
  // Some engines render midnight as hour 24 under h23; normalize to 0.
  let hour = field.hour;
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(field.year, field.month - 1, field.day, hour, field.minute, field.second);
  if (Number.isNaN(asUtc)) return null;
  return asUtc - at.getTime();
}

/**
 * Convert a wall-clock time expressed *in* `timeZone` to the absolute UTC
 * instant it denotes. Returns `null` for an unknown zone.
 *
 * Uses one offset-correction pass so results are exact except inside a DST
 * transition (where a wall time is skipped or repeated); there we fall back to
 * the pre-transition offset, which is a safe, deterministic choice for a
 * "reset" time (a real reset is always a future instant, and callers roll to
 * tomorrow when the candidate is already past).
 */
export function wallTimeInZoneToUtc(
  timeZone: string,
  year: number,
  month0: number,
  day: number,
  hour: number,
  minute: number
): Date | null {
  // First guess: pretend the wall time is UTC, then subtract the zone offset.
  const guess = Date.UTC(year, month0, day, hour, minute);
  if (Number.isNaN(guess)) return null;
  const offset = zoneOffsetMs(timeZone, new Date(guess));
  if (offset === null) return null;
  let utcMs = guess - offset;
  // Re-evaluate the offset at the corrected instant; if it changed (a DST
  // boundary sat between guess and utcMs), apply the corrected offset once.
  const corrected = zoneOffsetMs(timeZone, new Date(utcMs));
  if (corrected !== null && corrected !== offset) {
    utcMs = guess - corrected;
  }
  return new Date(utcMs);
}

/**
 * Resolve a bare clock time ("5pm", "3:00pm") stated in `timeZone` to the next
 * absolute instant at or after `now` when the zone's wall clock reads
 * `hour:minute` — today in that zone, or tomorrow if today's occurrence is
 * already past. Returns `null` for an unknown zone.
 *
 * This mirrors the local-time roll-to-tomorrow behavior of the parser's
 * clock-time patterns, but anchored to the named zone rather than the host's.
 */
export function nextClockTimeInZone(now: Date, hour: number, minute: number, timeZone: string): Date | null {
  const offsetNow = zoneOffsetMs(timeZone, now);
  if (offsetNow === null) return null;
  // The zone's wall-clock date for `now` (read the shifted instant as UTC).
  const wallNow = new Date(now.getTime() + offsetNow);
  const y = wallNow.getUTCFullYear();
  const mo = wallNow.getUTCMonth();
  const d = wallNow.getUTCDate();

  let candidate = wallTimeInZoneToUtc(timeZone, y, mo, d, hour, minute);
  if (!candidate) return null;
  if (candidate.getTime() <= now.getTime()) {
    // Date.UTC normalizes an overflowing day (e.g. day 32) into the next month.
    candidate = wallTimeInZoneToUtc(timeZone, y, mo, d + 1, hour, minute);
  }
  return candidate;
}
