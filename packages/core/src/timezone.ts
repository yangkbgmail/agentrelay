/**
 * Timezone-aware resolution of wall-clock reset times.
 *
 * Agent CLIs frequently print a reset time with an explicit timezone, e.g.
 * Claude Code's "Your limit will reset at 5pm (America/New_York).". The clock
 * patterns in `parser.ts` used to ignore that zone and interpret the hour in
 * the machine's *local* time — which is wrong whenever the daemon runs in a
 * different zone than the one the message names (very common: a UTC cloud/CI
 * box relaying a message that says a US-Eastern reset). That skews the reset
 * instant by whole hours, so the relay resumes too early (and re-hits the
 * limit) or too late.
 *
 * This module resolves a wall-clock time (hour:minute) that is stated in a
 * named zone into the correct absolute UTC instant, so `resetAt` reflects the
 * moment the message actually meant. Everything here is pure (no `Date.now()`;
 * `now` is injected) and depends only on the ICU data bundled with Node — no
 * external timezone tables.
 *
 * Supported zone forms (what agents realistically print):
 *   - IANA names:        `America/New_York`, `Europe/London`, `Asia/Seoul`
 *   - UTC/GMT + offset:  `UTC`, `GMT`, `UTC+9`, `GMT-5`, `UTC+05:30`, `GMT-0800`
 * Ambiguous abbreviations (PST/EST/…) are intentionally NOT resolved here —
 * they map to different offsets across the year and are unsafe to guess; such a
 * token normalizes to `null` and the parser keeps its local-time fallback.
 */

/**
 * A normalized zone is one of:
 *   - "UTC"                     — fixed +0
 *   - "OFFSET:<minutes>"        — a fixed offset east-of-UTC in minutes (may be negative)
 *   - a validated IANA zone id  — resolved via Intl at the relevant instant
 * `normalizeTimeZone` returns one of these or `null` for anything unrecognized.
 */
export function normalizeTimeZone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // UTC / GMT, optionally followed by a signed offset: UTC+9, GMT-5, UTC+05:30,
  // GMT-0800, or a bare UTC/GMT (= +0).
  const offsetMatch = trimmed.match(/^(?:UTC|GMT)(?:\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?)?$/i);
  if (offsetMatch) {
    if (!offsetMatch[1]) return "UTC"; // bare UTC/GMT
    const sign = offsetMatch[1] === "-" ? -1 : 1;
    const hours = Number.parseInt(offsetMatch[2], 10);
    const minutes = offsetMatch[3] ? Number.parseInt(offsetMatch[3], 10) : 0;
    if (hours > 14 || minutes > 59) return null; // outside the real UTC offset range
    const totalMinutes = sign * (hours * 60 + minutes);
    return totalMinutes === 0 ? "UTC" : `OFFSET:${totalMinutes}`;
  }

  // IANA zone id: at least one "/" segment, letters/digits/underscore/±. Validate
  // against ICU so a bogus "Foo/Bar" falls through to the local-time fallback.
  if (/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/.test(trimmed) && isValidIanaZone(trimmed)) {
    return trimmed;
  }

  return null;
}

function isValidIanaZone(zone: string): boolean {
  try {
    // Constructing a formatter throws RangeError for an unknown timeZone.
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

interface ZonedDateParts {
  year: number;
  /** 0-based month, matching `Date.UTC`. */
  month: number;
  day: number;
}

/** The east-of-UTC offset (ms) of `instant` in an IANA `zone`. */
function ianaOffsetMs(instant: number, zone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(instant));
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = Number.parseInt(part.value, 10);
  }
  const asUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  return asUtc - instant;
}

/** The calendar date (in `zone`) at the given absolute `instant`. */
function zonedDateParts(instant: number, zone: string): ZonedDateParts {
  if (zone === "UTC") {
    const d = new Date(instant);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
  }
  if (zone.startsWith("OFFSET:")) {
    const offsetMin = Number.parseInt(zone.slice("OFFSET:".length), 10);
    const shifted = new Date(instant + offsetMin * 60_000);
    return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
  }
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(instant));
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = Number.parseInt(part.value, 10);
  }
  return { year: map.year, month: map.month - 1, day: map.day };
}

/** The absolute instant (ms) of a wall-clock `hour:minute` on a given date in `zone`. */
function zonedWallToInstant(date: ZonedDateParts, hour: number, minute: number, zone: string): number {
  const wallAsUtc = Date.UTC(date.year, date.month, date.day, hour, minute);
  if (zone === "UTC") return wallAsUtc;
  if (zone.startsWith("OFFSET:")) {
    const offsetMin = Number.parseInt(zone.slice("OFFSET:".length), 10);
    return wallAsUtc - offsetMin * 60_000;
  }
  // Two-pass to settle DST: the offset can differ between the naive UTC guess and
  // the corrected instant (e.g. near a spring-forward / fall-back boundary).
  let result = wallAsUtc - ianaOffsetMs(wallAsUtc, zone);
  result = wallAsUtc - ianaOffsetMs(result, zone);
  return result;
}

/**
 * Resolve the next occurrence of `hour:minute` (24-hour) stated in `normalizedZone`,
 * relative to `now`. Picks today-in-zone, or rolls to tomorrow-in-zone if that
 * instant is already at/before `now` (a reset is always a future instant).
 *
 * `normalizedZone` must come from `normalizeTimeZone`. Returns `null` only if the
 * zone is malformed (callers treat that as "fall back to local time").
 */
export function resolveZonedClock(now: Date, hour: number, minute: number, normalizedZone: string): Date | null {
  if (!normalizedZone) return null;
  if (normalizedZone !== "UTC" && !normalizedZone.startsWith("OFFSET:") && !isValidIanaZone(normalizedZone)) {
    return null;
  }

  const nowMs = now.getTime();
  const today = zonedDateParts(nowMs, normalizedZone);
  let instant = zonedWallToInstant(today, hour, minute, normalizedZone);

  if (instant <= nowMs) {
    // Roll to the next calendar day *in the zone*. Anchor on local noon + 24h so
    // a DST transition can't land us back on the same date.
    const noonNextDay = zonedWallToInstant(today, 12, 0, normalizedZone) + 24 * 60 * 60_000;
    const tomorrow = zonedDateParts(noonNextDay, normalizedZone);
    instant = zonedWallToInstant(tomorrow, hour, minute, normalizedZone);
  }

  return new Date(instant);
}
