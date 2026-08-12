/**
 * "Active hours" gating for the relay scheduler.
 *
 * By default the relay resumes a job the moment its rate-limit window resets,
 * whatever the wall-clock time. Some users want resumes confined to a daily
 * window instead:
 *   - only overnight, so a herd of agent runs doesn't fire up during their own
 *     working hours and re-consume the very limit they share; or
 *   - only during the day, so a long unattended agent run isn't launched at 3am.
 *
 * `AGENTRELAY_ACTIVE_HOURS=22:00-06:00` expresses that as a daily *local-time*
 * window. When set, a scheduler tick whose reference time falls outside the
 * window performs no resumes; due jobs simply wait, and resume on the first tick
 * after the window opens.
 *
 * Everything here is pure and timezone-free: the core logic works in
 * minutes-of-day integers, and the thin {@link localMinutesOfDay} helper is the
 * only bridge to a real `Date` (using the machine's local time — what a user
 * writing "22:00" means). Keeping the math TZ-free makes it deterministically
 * testable without pinning the test runner's timezone.
 */

/** Minutes in a day. Exported so callers can reason about wrap-around. */
export const MINUTES_PER_DAY = 24 * 60;

/**
 * A daily active window, expressed as minutes from local midnight. `endMinute`
 * may be *less than or equal to* `startMinute`, which denotes an overnight
 * window that wraps past midnight (e.g. `22:00-06:00` → start 1320, end 360).
 */
export interface ActiveWindow {
  /** Inclusive start of the window, minutes from midnight in `[0, 1440)`. */
  startMinute: number;
  /** Exclusive end of the window, minutes from midnight in `[0, 1440)`. */
  endMinute: number;
}

/**
 * Parse an `AGENTRELAY_ACTIVE_HOURS`-style spec into an {@link ActiveWindow}.
 *
 * Accepted forms (whitespace around the dash is ignored):
 *   - `"22:00-06:00"` — explicit HH:MM on both sides
 *   - `"9-17"` — bare hours (minutes default to `:00`)
 *   - `"22:30-6"` — mixed
 *
 * Returns `null` for anything unparseable, out of range (hour > 23, minute > 59),
 * or a zero-width window (`start === end`, which can't be told apart from a
 * full-day window). A `null` result means "no gating" to callers — the relay
 * behaves exactly as it did before the feature existed.
 */
export function parseActiveHours(spec: string | undefined | null): ActiveWindow | null {
  if (typeof spec !== "string") return null;
  const trimmed = spec.trim();
  if (trimmed === "") return null;

  const match = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return null;

  const startMinute = toMinuteOfDay(match[1], match[2]);
  const endMinute = toMinuteOfDay(match[3], match[4]);
  if (startMinute === null || endMinute === null) return null;
  // A zero-width window is ambiguous (all day vs. no day); reject it so the
  // caller falls back to ungated behavior rather than silently never resuming.
  if (startMinute === endMinute) return null;

  return { startMinute, endMinute };
}

/** Convert an HH (+ optional MM) pair to minutes-of-day, or null when invalid. */
function toMinuteOfDay(hourStr: string, minuteStr: string | undefined): number | null {
  const hour = Number(hourStr);
  const minute = minuteStr === undefined ? 0 : Number(minuteStr);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * Whether a minute-of-day falls inside the window. Handles both same-day
 * windows (`start < end`, active when `start ≤ m < end`) and overnight windows
 * (`start > end`, active when `m ≥ start` OR `m < end`). The input minute is
 * normalized into `[0, 1440)` so out-of-range values still resolve sensibly.
 */
export function isMinuteWithinWindow(window: ActiveWindow, minute: number): boolean {
  const m = ((Math.floor(minute) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const { startMinute: start, endMinute: end } = window;
  if (start < end) return m >= start && m < end;
  return m >= start || m < end; // overnight wrap
}

/**
 * Minutes from `minute` until the window next opens, or `0` when already inside
 * it. For a minute outside the window this is the (positive) wait until the next
 * `startMinute`, wrapping past midnight if needed.
 */
export function minutesUntilWindowOpens(window: ActiveWindow, minute: number): number {
  if (isMinuteWithinWindow(window, minute)) return 0;
  const m = ((Math.floor(minute) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return (((window.startMinute - m) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** Local minute-of-day for a `Date` (machine local time), in `[0, 1440)`. */
export function localMinutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** Whether `date` (in machine-local time) falls inside the active window. */
export function isWithinActiveWindow(window: ActiveWindow, date: Date): boolean {
  return isMinuteWithinWindow(window, localMinutesOfDay(date));
}

/**
 * The next instant at/after `date` when the window is open. Returns `date`
 * itself when already inside the window. Resolution is one minute (seconds of
 * `date` are ignored in the offset), which is plenty for a status banner / the
 * scheduler's minute-granular gating.
 */
export function nextWindowOpen(window: ActiveWindow, date: Date): Date {
  const waitMinutes = minutesUntilWindowOpens(window, localMinutesOfDay(date));
  if (waitMinutes === 0) return date;
  return new Date(date.getTime() + waitMinutes * 60_000);
}

/** Render a window back to `HH:MM-HH:MM` (24h, zero-padded) for display. */
export function formatActiveWindow(window: ActiveWindow): string {
  return `${formatMinute(window.startMinute)}-${formatMinute(window.endMinute)}`;
}

function formatMinute(minute: number): string {
  const hh = Math.floor(minute / 60);
  const mm = minute % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * Build the active window from the environment (`AGENTRELAY_ACTIVE_HOURS`),
 * or `null` when unset/invalid. Mirrors the other `*FromEnv` tuning helpers so
 * a user can gate the relay without code changes.
 */
export function activeWindowFromEnv(env: NodeJS.ProcessEnv = process.env): ActiveWindow | null {
  return parseActiveHours(env.AGENTRELAY_ACTIVE_HOURS);
}
