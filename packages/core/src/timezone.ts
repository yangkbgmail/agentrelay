/**
 * Timezone-aware resolution of wall-clock reset times.
 *
 * Agent CLIs print reset times in the *account's* timezone, not the machine's,
 * e.g. Claude Code's "Your limit will reset at 5pm (America/New_York)." When
 * AgentRelay runs on a machine in a different timezone, interpreting "5pm" in
 * local time is wrong by the offset between the two zones — the relay would
 * resume the job too early (it re-hits the limit) or too late (wasted window).
 *
 * These helpers turn a wall-clock hour/minute *in a named IANA zone* into the
 * correct absolute UTC instant, using only `Intl.DateTimeFormat` (built into
 * Node's full-ICU build) — no dependencies, matching the repo's zero-dep rule.
 * Everything here is pure: the caller injects `now`, so results are testable
 * regardless of the host machine's own timezone.
 */

/**
 * The UTC offset (ms) of a named IANA timezone at a given UTC instant, i.e.
 * `wallClockAsUTC - actualUTC`. Positive east of UTC (e.g. +9h for Asia/Seoul),
 * negative west (e.g. -4h for America/New_York in summer). Returns `null` when
 * `timeZone` is not a zone the runtime recognizes, so callers can fall back.
 *
 * Works by formatting the instant *in the target zone* and reading the wall
 * clock back out: the difference between that wall clock (interpreted as if it
 * were UTC) and the real instant is exactly the zone's offset then — which
 * inherently accounts for DST, since we measure at the specific instant.
 */
export function tzOffsetMsAt(utcMs: number, timeZone: string): number | null {
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
    parts = dtf.formatToParts(new Date(utcMs));
  } catch {
    return null; // invalid/unknown IANA zone
  }
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const wallAsUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    // h23 renders midnight as "24" in some ICU versions; normalize to 0.
    Number(map.hour) % 24,
    Number(map.minute),
    Number(map.second)
  );
  if (Number.isNaN(wallAsUtc)) return null;
  return wallAsUtc - utcMs;
}

/**
 * Given a wall-clock (`year`/`month1..12`/`day`/`hour`/`minute`) *in* `timeZone`,
 * return the absolute UTC epoch ms it denotes, or `null` for an unknown zone.
 *
 * A zone's offset depends on the instant (DST), and the instant is what we're
 * solving for — a chicken-and-egg. We break it with one correction pass: guess
 * the offset at the naive "as-if-UTC" reading, apply it, then re-measure the
 * offset at that candidate and re-apply if a DST boundary changed it. One pass
 * converges everywhere except inside the ~1h DST gaps/overlaps, which reset
 * times don't realistically land on.
 */
export function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number | null {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  if (Number.isNaN(naive)) return null;
  const offset1 = tzOffsetMsAt(naive, timeZone);
  if (offset1 === null) return null;
  const candidate = naive - offset1;
  const offset2 = tzOffsetMsAt(candidate, timeZone);
  if (offset2 === null) return null;
  return offset2 === offset1 ? candidate : naive - offset2;
}

/**
 * The next future instant (`> now`) at which the clock in `timeZone` reads
 * `hour`:`minute`. Mirrors the local-time "roll to tomorrow if already past"
 * behavior of the parser's clock patterns, but anchored to the message's own
 * zone. Returns `null` when `timeZone` is unrecognized so the caller can fall
 * back to local-time interpretation (best-effort, never throws).
 */
export function nextZonedInstant(now: Date, hour: number, minute: number, timeZone: string): Date | null {
  const nowMs = now.getTime();
  // Today's calendar date *as seen in the target zone* (not the host's).
  const offsetNow = tzOffsetMsAt(nowMs, timeZone);
  if (offsetNow === null) return null;
  const zoneWall = new Date(nowMs + offsetNow); // wall clock read via UTC getters
  const year = zoneWall.getUTCFullYear();
  const month = zoneWall.getUTCMonth() + 1;
  const day = zoneWall.getUTCDate();

  let candidate = zonedWallClockToUtc(year, month, day, hour, minute, timeZone);
  if (candidate === null) return null;
  if (candidate <= nowMs) {
    // Advance one calendar day in the zone; Date.UTC normalizes month/year rollover.
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    candidate = zonedWallClockToUtc(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      hour,
      minute,
      timeZone
    );
    if (candidate === null) return null;
  }
  return new Date(candidate);
}
