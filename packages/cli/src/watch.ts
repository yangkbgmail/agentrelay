// Shared live `--watch` plumbing for the countdown-style read commands
// (`upcoming`, `overdue`, `tools`, `projects`). Each of these renders relative
// countdowns to a reset time, so a mode that clears the screen and re-renders
// on an interval — the way `status --watch` already works — lets the numbers
// tick down in place. The parsing and header formatting are kept pure (and
// unit-tested) here; only `runWatchLoop` touches stdout/timers/signals so the
// individual command actions stay a couple of lines.

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Default refresh cadence when `--watch` is given no explicit seconds. */
export const DEFAULT_WATCH_SECONDS = 2;

/**
 * Turn a commander `--watch [seconds]` value into a poll interval in
 * milliseconds. Mirrors `status --watch`: a positive finite number of seconds
 * is honoured (rounded to the nearest ms), and anything else — the bare flag
 * (`true`), a non-number, zero, or a negative — falls back to the default.
 * Pure and clock-free so it can be tested directly.
 */
export function parseWatchInterval(
  watch: string | boolean | undefined,
  defaultSeconds: number = DEFAULT_WATCH_SECONDS
): number {
  const parsed = typeof watch === "string" ? Number.parseFloat(watch) : Number.NaN;
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultSeconds;
  return Math.round(seconds * 1000);
}

/**
 * The two-line banner printed above each live frame: a bold title with the
 * refresh cadence + Ctrl-C hint, and a dim line with the timestamp and store
 * path. Kept pure (takes `now`, no ambient clock) and colour-gated so the
 * output is identical to the `status --watch` header style and testable.
 */
export function renderWatchHeader(
  command: string,
  storePath: string,
  intervalMs: number,
  now: number,
  color = true
): string {
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const stamp = new Date(now).toISOString().replace("T", " ").slice(0, 19);
  const seconds = Math.round(intervalMs / 1000);
  const title = `${b(`agentrelay ${command}`)} ${d(`(live, every ${seconds}s — Ctrl-C to exit)`)}`;
  const meta = d(`${stamp}Z · ${storePath}`);
  return `${title}\n${meta}`;
}

/**
 * Run `draw` immediately and then every `intervalMs`, clearing the screen +
 * homing the cursor before each pass so the frame repaints in place. `draw`
 * receives a fresh `Date.now()` per frame (the caller re-reads the store there,
 * so a running daemon's writes and ticking countdowns both show up). Runs until
 * the process is interrupted (Ctrl-C / SIGTERM), then exits cleanly. The
 * `setInterval` keeps the event loop alive, so callers return right after this.
 */
export function runWatchLoop(intervalMs: number, draw: (now: number) => void): void {
  const paint = (): void => {
    // Clear screen + move cursor home, then let the caller paint the frame.
    process.stdout.write("\x1b[2J\x1b[H");
    draw(Date.now());
  };
  paint();
  const timer = setInterval(paint, intervalMs);
  const stop = (): void => {
    clearInterval(timer);
    process.stdout.write("\n");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
