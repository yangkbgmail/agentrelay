/**
 * Colour output resolution for the CLI.
 *
 * Every human-facing renderer (`status`, `stats`, `doctor`, `show`, …) takes a
 * `color` boolean. Until now each call site computed that independently as
 * `Boolean(process.stdout.isTTY)`, so there was no way to force colour off (for
 * logs, CI, or piping into a file) or on (for a pager that renders ANSI).
 *
 * This module centralises the decision in one pure, testable function that
 * honours the widely-adopted conventions:
 *   - a `--no-color` CLI flag (the user's direct, explicit intent),
 *   - the `NO_COLOR` env var (https://no-color.org — set and non-empty ⇒ off),
 *   - the `FORCE_COLOR` env var (set and truthy ⇒ on, even without a TTY),
 * falling back to whether stdout is a TTY.
 */

/** Env values that make `FORCE_COLOR` mean "off" rather than "on". */
const FORCE_COLOR_FALSY = new Set(["", "0", "false", "no", "off"]);

export interface ColorInput {
  /** The `--no-color` global flag; when true, colour is always disabled. */
  noColorFlag?: boolean;
  /** Environment to read `NO_COLOR`/`FORCE_COLOR` from (defaults to none). */
  env?: Record<string, string | undefined>;
  /** Whether the output stream is a TTY (the fallback signal). */
  isTTY?: boolean;
}

/**
 * Decide whether ANSI colour should be emitted, in this precedence order:
 *   1. `--no-color` flag set ⇒ never colour.
 *   2. `NO_COLOR` present and non-empty ⇒ never colour.
 *   3. `FORCE_COLOR` present and truthy ⇒ always colour.
 *   4. otherwise ⇒ colour iff stdout is a TTY.
 *
 * Both "off" signals (the flag and `NO_COLOR`) are checked before the "on"
 * signal, so a user who asks for no colour always wins over a stray
 * `FORCE_COLOR` inherited from the environment.
 */
export function shouldUseColor(input: ColorInput = {}): boolean {
  if (input.noColorFlag) return false;

  const env = input.env ?? {};

  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return false;

  const forceColor = env.FORCE_COLOR;
  if (forceColor !== undefined && !FORCE_COLOR_FALSY.has(forceColor.toLowerCase())) {
    return true;
  }

  return Boolean(input.isTTY);
}
