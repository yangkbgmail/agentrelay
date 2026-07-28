/**
 * Resume window ("active hours" / "quiet hours") support.
 *
 * By default AgentRelay resumes a rate-limited job the moment its reset time
 * passes — at any hour of the day. That is not always wanted: a coding agent
 * auto-resuming at 3am (burning tokens, pushing commits while nobody is
 * watching) or during a meeting can be surprising. A *resume window* restricts
 * the scheduler so it only resumes jobs during a configured daily time range,
 * in the machine's **local** time. Outside the window the scheduler simply
 * doesn't resume anything; a job whose reset already passed just waits until
 * the window next opens (it is never failed for this).
 *
 * The window is expressed as `HH:MM-HH:MM` (24-hour clock). A start later than
 * the end wraps past midnight, so `22:00-06:00` means "overnight". The feature
 * is entirely opt-in: with no window configured every helper here treats resume
 * as always allowed, so behavior is unchanged.
 *
 * Everything in this module is pure (no filesystem, no ambient clock — the one
 * time helper takes an injected {@link Date}) so it is trivially unit-testable
 * and the scheduler stays deterministic in tests.
 */

/** Env var that carries the resume window, e.g. `AGENTRELAY_RESUME_WINDOW=09:00-18:00`. */
export const RESUME_WINDOW_ENV = "AGENTRELAY_RESUME_WINDOW";

/** Minutes in a day — the modulus for all minute-of-day arithmetic. */
export const MINUTES_PER_DAY = 24 * 60;

/**
 * A daily time range during which the scheduler is allowed to resume jobs.
 * `startMinute`/`endMinute` are minutes since local midnight in `[0, 1439]`.
 * When `startMinute < endMinute` the window is a normal same-day range
 * `[start, end)`. When `startMinute > endMinute` it wraps past midnight
 * (e.g. 22:00→06:00). The two are never equal (that would be ambiguous between
 * "empty" and "all day", so {@link parseResumeWindow} rejects it — an all-day
 * window is simply "no window configured").
 */
export interface ResumeWindow {
  startMinute: number;
  endMinute: number;
}

/**
 * Parses one clock token (`H`, `HH`, `H:MM`, or `HH:MM`, 24-hour) into minutes
 * since midnight, or `null` when it is malformed / out of range. A bare hour
 * (`9`, `18`) is taken as `:00`.
 */
export function parseClockMinutes(token: string): number | null {
  const match = /^(\d{1,2})(?::([0-5]\d))?$/.exec(token.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  if (hours > 23) return null;
  return hours * 60 + minutes;
}

/**
 * Parses a `HH:MM-HH:MM` resume window (each side may also be a bare hour), or
 * `null` when the input is blank or malformed. Equal start/end is rejected as
 * `null` (see {@link ResumeWindow}). Whitespace around the whole value and each
 * side is tolerated.
 */
export function parseResumeWindow(input: string): ResumeWindow | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const parts = trimmed.split("-");
  if (parts.length !== 2) return null;
  const startMinute = parseClockMinutes(parts[0]);
  const endMinute = parseClockMinutes(parts[1]);
  if (startMinute === null || endMinute === null) return null;
  if (startMinute === endMinute) return null;
  return { startMinute, endMinute };
}

/**
 * Reads the resume window from the environment, or `null` when it is unset,
 * blank, or malformed. A malformed value fails **open** (returns `null` → the
 * window is treated as disabled and jobs still resume) rather than silently
 * blocking every resume, which for a relay tool is by far the safer failure;
 * `agentrelay config validate` surfaces the typo before it ever matters.
 */
export function resumeWindowFromEnv(env: Record<string, string | undefined> = process.env): ResumeWindow | null {
  const raw = env[RESUME_WINDOW_ENV];
  if (raw === undefined || raw.trim() === "") return null;
  return parseResumeWindow(raw);
}

/** Minutes since local midnight for `date`, in `[0, 1439]`. Uses the machine's local timezone. */
export function localMinuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * True when `minuteOfDay` falls inside `window`, honoring an overnight
 * (start > end) wraparound. The window is half-open `[start, end)` so back-to-back
 * windows don't both claim the boundary minute. An (invalid) equal-endpoint
 * window is treated as empty.
 */
export function isWithinResumeWindow(minuteOfDay: number, window: ResumeWindow): boolean {
  const { startMinute, endMinute } = window;
  if (startMinute === endMinute) return false;
  if (startMinute < endMinute) {
    return minuteOfDay >= startMinute && minuteOfDay < endMinute;
  }
  // Wraps past midnight: inside if at/after start OR before end.
  return minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

/**
 * Whether the scheduler may resume jobs at `now`. With no window (`null`) resume
 * is always allowed, so the default behavior is unchanged. Otherwise the local
 * time-of-day of `now` must fall inside the window.
 */
export function isResumeAllowed(now: Date, window: ResumeWindow | null): boolean {
  if (!window) return true;
  return isWithinResumeWindow(localMinuteOfDay(now), window);
}

/** Formats a minute-of-day as zero-padded `HH:MM`. */
export function formatClockMinutes(minuteOfDay: number): string {
  const normalized = ((minuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Human-readable `HH:MM–HH:MM` rendering of a window (for banners / diagnostics). */
export function formatResumeWindow(window: ResumeWindow): string {
  return `${formatClockMinutes(window.startMinute)}–${formatClockMinutes(window.endMinute)}`;
}
