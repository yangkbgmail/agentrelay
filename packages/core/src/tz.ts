/**
 * Timezone-aware resolution for clock-time rate-limit messages.
 *
 * The bare clock-time parser patterns ("resets at 5pm", "resets at 15:00")
 * historically interpreted the hour in the *host machine's* local timezone.
 * But the real Claude Code wording names a zone the reset is quoted in —
 * "Your limit will reset at 5pm (America/New_York)." — and agent CLIs proxying
 * an HTTP API often print a UTC offset ("resets at 15:00 UTC", "resets at 5pm
 * +09:00"). On a daemon whose host isn't in that zone, interpreting the hour
 * locally computes the wrong instant and the relay resumes too early, hitting
 * the same rate limit again and burning a retry.
 *
 * This module turns "HH:MM in <zone>" into the correct next future UTC instant.
 * It is pure given an injected `now` (no ambient clock) and dependency-free:
 * fixed offsets are plain arithmetic, and IANA zone names are resolved through
 * the built-in `Intl.DateTimeFormat` (Node ships full ICU), so no timezone
 * database dependency is added. When no zone is present in a message the parser
 * keeps its original local-time behavior — this only kicks in when a zone was
 * actually quoted.
 */

const DAY_MS = 86_400_000;

/** A parsed timezone token: either a fixed UTC offset or a named IANA zone. */
export type ZoneSpec = { kind: "offset"; offsetMs: number } | { kind: "iana"; timeZone: string };

/** IANA zone validity is stable per process; cache Intl probes so we don't re-throw. */
const tzValidityCache = new Map<string, boolean>();

function isValidTimeZone(timeZone: string): boolean {
  const cached = tzValidityCache.get(timeZone);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    // Constructing with an invalid timeZone throws RangeError; a valid one is cheap.
    new Intl.DateTimeFormat("en-US", { timeZone });
    ok = true;
  } catch {
    ok = false;
  }
  tzValidityCache.set(timeZone, ok);
  return ok;
}

/**
 * Parses a timezone token captured after a clock time into a {@link ZoneSpec},
 * or null when it isn't a zone we can resolve. Recognizes:
 *   - `Z`, `UTC`, `GMT` (case-insensitive)            -> offset 0
 *   - `+09:00`, `-0500`, `+9`, `-05:30`               -> fixed UTC offset
 *   - `America/New_York`, `Europe/London`, IANA names -> named zone (validated)
 * Ambiguous letter abbreviations like `ET`/`PST` are deliberately rejected —
 * they map to different offsets in different regions and can't be resolved
 * safely without guessing. Rejecting them leaves the parser on its existing
 * local-time path rather than inventing a wrong instant.
 */
export function parseZoneToken(raw: string): ZoneSpec | null {
  const token = raw.trim();
  if (!token) return null;

  const upper = token.toUpperCase();
  if (upper === "Z" || upper === "UTC" || upper === "GMT") return { kind: "offset", offsetMs: 0 };

  const off = token.match(/^([+-])(\d{1,2}):?(\d{2})?$/);
  if (off) {
    const sign = off[1] === "-" ? -1 : 1;
    const hours = Number.parseInt(off[2], 10);
    const minutes = off[3] !== undefined ? Number.parseInt(off[3], 10) : 0;
    if (hours > 14 || minutes > 59) return null; // real UTC offsets span -12..+14
    return { kind: "offset", offsetMs: sign * (hours * 60 + minutes) * 60_000 };
  }

  if (/^[A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(token)) {
    return isValidTimeZone(token) ? { kind: "iana", timeZone: token } : null;
  }

  return null;
}

/**
 * The offset a named zone is at for a given UTC instant, as `localWall - utc`
 * in ms (e.g. New York in summer -> -4h). Computed by asking Intl to format the
 * instant in that zone and reading back the wall-clock fields. Returns null if
 * the zone/format can't be resolved.
 */
function ianaOffsetMs(timeZone: string, utcMs: number): number | null {
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
    const parts = dtf.formatToParts(new Date(utcMs));
    const map: Record<string, string> = {};
    for (const part of parts) map[part.type] = part.value;
    let hour = Number.parseInt(map.hour, 10);
    if (hour === 24) hour = 0; // some ICU builds render midnight as "24"
    const asIfUtc = Date.UTC(
      Number.parseInt(map.year, 10),
      Number.parseInt(map.month, 10) - 1,
      Number.parseInt(map.day, 10),
      hour,
      Number.parseInt(map.minute, 10),
      Number.parseInt(map.second, 10)
    );
    if (Number.isNaN(asIfUtc)) return null;
    return asIfUtc - utcMs;
  } catch {
    return null;
  }
}

/**
 * Converts a wall-clock Y-M-D H:M *in `zone`* to a UTC instant (epoch ms), or
 * null when a named zone can't be resolved. For fixed offsets it's arithmetic;
 * for IANA zones we take the offset at the naive instant and refine once so a
 * reset that lands across a DST transition still resolves correctly.
 */
function wallClockToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: ZoneSpec
): number | null {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  if (zone.kind === "offset") return naiveUtc - zone.offsetMs;

  const firstOffset = ianaOffsetMs(zone.timeZone, naiveUtc);
  if (firstOffset === null) return null;
  let utc = naiveUtc - firstOffset;
  const secondOffset = ianaOffsetMs(zone.timeZone, utc);
  if (secondOffset !== null && secondOffset !== firstOffset) utc = naiveUtc - secondOffset;
  return utc;
}

/**
 * Resolves "HH:MM in `zone`" to the next instant strictly after `now`, honoring
 * the zone. It evaluates the wall time on the UTC calendar dates around `now`
 * (yesterday, today, tomorrow) — a ±1-day window covers every possible zone
 * offset — converts each to a UTC instant, and returns the earliest one still
 * in the future. This mirrors the local-time patterns' "assume the next time it
 * strikes that clock" semantics, but anchored to the quoted zone. Returns null
 * when the zone can't be resolved (caller then falls back to local time).
 */
export function resolveZonedClockTime(hour: number, minute: number, zone: ZoneSpec, now: Date): Date | null {
  const nowMs = now.getTime();
  const baseDayMs = Math.floor(nowMs / DAY_MS) * DAY_MS;

  const candidates: number[] = [];
  for (const dayOffset of [-1, 0, 1]) {
    const day = new Date(baseDayMs + dayOffset * DAY_MS);
    const ms = wallClockToUtcMs(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, zone);
    if (ms !== null) candidates.push(ms);
  }

  const future = candidates.filter((ms) => ms > nowMs).sort((a, b) => a - b);
  return future.length > 0 ? new Date(future[0]) : null;
}
