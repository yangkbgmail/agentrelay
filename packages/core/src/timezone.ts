/**
 * Timezone-aware wall-clock resolution for the rate-limit parser.
 *
 * Agent CLIs print a reset as a wall-clock time in a *named* timezone, e.g.
 * "Claude usage limit reached. Your limit will reset at 5pm (America/New_York)."
 * The parser historically interpreted that hour in the *machine's local* time
 * and ignored the zone, so a job on a UTC server would resume at 5pm UTC
 * instead of 5pm New York — hours off. Resuming too early just hits the limit
 * again (a wasted attempt); too late wastes the window. Either way it defeats
 * the point of the relay.
 *
 * These helpers convert a wall-clock time in an IANA timezone to the correct
 * UTC instant using the built-in `Intl` API — no dependencies, per the
 * project's zero-dependency rule (see `queue.ts`). They are pure and
 * side-effect free so the parser and tests can use them directly.
 */

/** A `formatToParts` numeric field set, keyed by part type. */
interface WallClockParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = FORMATTER_CACHE.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    FORMATTER_CACHE.set(timeZone, f);
  }
  return f;
}

/**
 * True when `timeZone` is a resolver the runtime's `Intl` accepts (an IANA
 * identifier like `America/New_York`, or `UTC`). Invalid names make
 * `Intl.DateTimeFormat` throw a `RangeError`; we turn that into `false` so
 * callers can cheaply probe a token pulled out of noisy CLI output.
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.trim() === "") return false; // Intl treats "" as the system default; not a real zone.
  try {
    // Constructing the formatter is what validates the zone.
    getFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a timezone token extracted from a message into an `Intl`-acceptable
 * identifier, or `null` when it can't be safely resolved.
 *
 * Accepted: IANA identifiers (`America/New_York`, `Europe/London`, `UTC`,
 * `GMT`, `Etc/UTC`, …) — anything `Intl` recognizes. Also the fixed synonyms
 * `Z`/`ZULU` → `UTC`.
 *
 * Deliberately rejected: bare civil abbreviations like `PST`/`EST`/`IST`. They
 * are ambiguous (IST alone is India, Ireland, *and* Israel time), and although
 * some `Intl` builds happen to resolve a few of them, guessing one risks a
 * wrong wait — worse than falling back to local time, which the caller does
 * when this returns `null`. So only a region/city IANA name (contains `/`) or
 * the fixed `UTC`/`GMT` (+ `Z`/`Zulu`) synonyms are accepted, regardless of
 * what the runtime's `Intl` would tolerate. This mirrors the parser's
 * `TZ_FRAGMENT`, which likewise only captures a slashed name or UTC/GMT.
 */
export function normalizeTimeZone(token: string | undefined | null): string | null {
  if (!token) return null;
  const trimmed = token.trim();
  if (trimmed === "") return null;
  const upper = trimmed.toUpperCase();
  if (upper === "Z" || upper === "ZULU") return "UTC";
  if (upper === "UTC" || upper === "GMT") return upper;
  if (!trimmed.includes("/")) return null; // reject bare abbreviations / single-word zones
  return isValidTimeZone(trimmed) ? trimmed : null;
}

/** Read the numeric wall-clock `Intl` shows for `instant` in `timeZone`. */
function wallClockPartsInZone(instant: Date, timeZone: string): WallClockParts {
  const parts = getFormatter(timeZone).formatToParts(instant);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = Number.parseInt(p.value, 10);
  }
  // Under `h23` some engines emit hour `24` for midnight; normalize to `0`.
  const hour = map.hour === 24 ? 0 : map.hour;
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour,
    minute: map.minute,
    second: map.second,
  };
}

function partsToPseudoUtcMs(p: WallClockParts): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/**
 * Offset of `timeZone` from UTC at `instant`, in milliseconds
 * (`localWallClock - UTC`). Positive east of UTC. Accounts for DST because it
 * is derived from what the zone actually displays at that instant.
 */
export function timeZoneOffsetMs(timeZone: string, instant: Date): number {
  const asIfUtc = partsToPseudoUtcMs(wallClockPartsInZone(instant, timeZone));
  return asIfUtc - instant.getTime();
}

/** The calendar date (in `timeZone`) that `instant` falls on. */
export function zoneCalendarDate(instant: Date, timeZone: string): { year: number; month: number; day: number } {
  const { year, month, day } = wallClockPartsInZone(instant, timeZone);
  return { year, month, day };
}

/**
 * Convert a wall-clock time in `timeZone` to the UTC instant it denotes.
 *
 * Uses the standard two-pass offset algorithm: guess the instant by treating
 * the fields as if they were UTC, look up the zone's offset there, subtract it,
 * then re-check the offset at the corrected instant. The second pass matters at
 * DST boundaries, where the offset at the guess can differ from the offset at
 * the true instant.
 *
 * Note: at a spring-forward gap the named wall-clock doesn't exist and at a
 * fall-back overlap it happens twice; the two-pass result lands on a sane
 * neighboring instant either way, which is good enough for a rate-limit reset.
 */
export function zonedWallClockToUtc(
  fields: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
  timeZone: string
): Date {
  const { year, month, day, hour, minute, second = 0 } = fields;
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset1 = timeZoneOffsetMs(timeZone, new Date(guessMs));
  const candidateMs = guessMs - offset1;
  const offset2 = timeZoneOffsetMs(timeZone, new Date(candidateMs));
  const finalMs = offset1 === offset2 ? candidateMs : guessMs - offset2;
  return new Date(finalMs);
}
