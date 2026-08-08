// Pure UTC-offset helpers for the `agentrelay stats` activity histograms.
// The distributions (--hours/--weekday/--trend) bucket jobs by wall-clock time,
// which is only meaningful relative to a timezone. Rather than pull in a
// timezone database (and its IANA-zone/DST complexity), we take a fixed UTC
// offset in minutes — enough to answer "which hour/day do I get throttled in my
// own time?" — and keep every function pure so it stays unit-testable without a
// clock or environment.

/** Minutes in one hour. */
const MIN_PER_HOUR = 60;
/** Milliseconds in one minute — for shifting an epoch-ms value by an offset. */
export const MS_PER_MINUTE = 60_000;
/**
 * Widest real-world UTC offset magnitude in minutes (±14:00, Line Islands /
 * Kiribati). Offsets beyond this aren't used by any timezone, so we reject them
 * as almost certainly a typo rather than silently bucketing into a phantom zone.
 */
const MAX_OFFSET_MINUTES = 14 * MIN_PER_HOUR;

/**
 * Parses a UTC-offset string into minutes east of UTC (positive = ahead of UTC,
 * e.g. `+09:00` → 540; negative = behind, e.g. `-05:30` → -330). Accepts:
 *   - `UTC`, `GMT`, `Z` (case-insensitive) → 0
 *   - `+HH`, `+HH:MM`, `+HHMM` and the `-` forms, with an optional leading
 *     `UTC`/`GMT` prefix (`UTC+9`, `GMT-05:00`)
 *   - a bare hour like `+9` / `-5` / `9` (an unsigned value means east of UTC)
 *
 * Returns null for anything unparseable or an offset beyond ±14:00 (the widest
 * offset any real timezone uses). Pure: no clock, no environment.
 */
export function parseUtcOffsetMinutes(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const upper = trimmed.toUpperCase();
  if (upper === "UTC" || upper === "GMT" || upper === "Z") return 0;
  // Strip an optional UTC/GMT prefix so "UTC+9" and "+9" parse the same.
  const body = upper.startsWith("UTC") || upper.startsWith("GMT") ? upper.slice(3) : upper;
  const match = body.match(/^([+-]?)(\d{1,2})(?::?([0-5]\d))?$/);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = match[3] !== undefined ? Number(match[3]) : 0;
  const total = sign * (hours * MIN_PER_HOUR + minutes);
  if (Math.abs(total) > MAX_OFFSET_MINUTES) return null;
  return total;
}

/**
 * Formats an offset (minutes east of UTC) back into a stable label for headers
 * and footers: 0 → `UTC`, 540 → `UTC+09:00`, -330 → `UTC-05:30`. Pure inverse
 * of {@link parseUtcOffsetMinutes} for canonical inputs.
 */
export function formatUtcOffsetLabel(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / MIN_PER_HOUR)).padStart(2, "0");
  const mm = String(abs % MIN_PER_HOUR).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}
