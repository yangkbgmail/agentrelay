// Color output policy for the CLI.
//
// Historically every render site hard-coded `Boolean(process.stdout.isTTY)` to
// decide whether to emit ANSI color. That ignored the two de-facto standards
// users reach for when piping logs or forcing color in CI:
//   - NO_COLOR (https://no-color.org/): when set to a non-empty string, disable
//     color regardless of anything else auto-detected.
//   - FORCE_COLOR (widely used by chalk/npm/node): when set, force color on
//     (except the disabling values "0"/"false").
// plus an explicit `--color <when>` / `--no-color` flag that beats the env.
//
// This module is pure (no process/tty/env access of its own) so it is trivially
// unit-testable; the CLI passes in the resolved flag value, `process.env`, and
// `process.stdout.isTTY`.

export type ColorPreference = "auto" | "always" | "never";

/**
 * Normalize the raw value Commander produces for the `--color`/`--no-color`
 * flags into a tri-state preference.
 *
 * Commander yields:
 *   - `undefined` when neither flag is passed  -> "auto"
 *   - `false` when `--no-color` is passed       -> "never"
 *   - `true` when a bare `--color` is passed     -> "always"
 *   - a string ("auto"/"always"/"never") when `--color <when>` is passed
 *
 * Any other string is rejected with a clear error so a typo fails loudly
 * instead of silently falling back to auto.
 */
export function normalizeColorPreference(value: string | boolean | undefined): ColorPreference {
  if (value === undefined) return "auto";
  if (value === false) return "never";
  if (value === true) return "always";
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized === "always" || normalized === "never") {
    return normalized;
  }
  throw new Error(`Invalid --color value "${value}". Use one of: auto, always, never.`);
}

export interface ColorContext {
  preference?: ColorPreference;
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
}

/**
 * Decide whether to emit ANSI color.
 *
 * Precedence (most explicit first):
 *   1. `--color always` / `--color never` (and `--no-color`) — the user asked.
 *   2. auto: NO_COLOR (non-empty) disables; then FORCE_COLOR enables (unless
 *      "0"/"false"); then fall back to TTY detection.
 */
export function shouldUseColor({ preference = "auto", env = {}, isTTY = false }: ColorContext): boolean {
  if (preference === "always") return true;
  if (preference === "never") return false;

  // NO_COLOR: presence with a non-empty value disables color (spec is explicit
  // that an empty string does NOT count).
  const noColor = env.NO_COLOR;
  if (typeof noColor === "string" && noColor.length > 0) return false;

  // FORCE_COLOR: presence enables color; "0"/"false" is the documented off-switch.
  const forceColor = env.FORCE_COLOR;
  if (typeof forceColor === "string") {
    const normalized = forceColor.trim().toLowerCase();
    return normalized !== "0" && normalized !== "false";
  }

  return isTTY;
}
