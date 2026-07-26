// Decides whether human-facing command output should include ANSI color.
//
// Until now every renderer was gated on `Boolean(process.stdout.isTTY)` alone,
// so AgentRelay ignored two things it should honor: the widely-adopted
// `NO_COLOR` / `FORCE_COLOR` environment conventions (https://no-color.org and
// chalk/supports-color) and an explicit `--color` / `--no-color` flag. That
// meant raw escape codes leaked into CI logs and files that set `NO_COLOR`, and
// there was no way to force color through a pipe. This module centralizes the
// decision as one pure function so the whole CLI resolves color identically and
// the precedence is unit-testable without a TTY.

import type { Command } from "commander";

/** Explicit color preference, if the user passed `--color` / `--no-color`. */
export type ColorFlag = "always" | "never" | "auto";

export interface ColorInput {
  /**
   * The explicit `--color` / `--no-color` flag. `"auto"` (or omitted) defers to
   * the environment and TTY. An explicit flag always wins over the environment.
   */
  flag?: ColorFlag;
  /** Whether the destination stream is an interactive terminal. */
  isTTY?: boolean;
  /** Environment carrying `NO_COLOR` / `FORCE_COLOR`. Defaults to `{}`. */
  env?: Record<string, string | undefined>;
}

/**
 * Resolve whether to emit ANSI color, applying this precedence (highest first):
 *
 *   1. An explicit `--color` / `--no-color` flag.
 *   2. `NO_COLOR` — present and non-empty disables color regardless of value
 *      (an empty string is treated as unset, per the no-color.org spec).
 *   3. `FORCE_COLOR` — `"0"`/`"false"` disables; any other present value forces
 *      color on even when not writing to a TTY (chalk/supports-color convention).
 *   4. Otherwise colorize only when writing to an interactive terminal.
 */
export function resolveColor(input: ColorInput): boolean {
  const { flag, isTTY } = input;
  const env = input.env ?? {};

  if (flag === "never") return false;
  if (flag === "always") return true;

  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return false;

  const forceColor = env.FORCE_COLOR;
  if (forceColor !== undefined) {
    if (forceColor === "0" || forceColor.toLowerCase() === "false") return false;
    return true;
  }

  return Boolean(isTTY);
}

/**
 * Read the effective color flag off a commander program that defines both
 * `--color` and `--no-color`. Returns `"auto"` unless the user actually passed
 * one on the command line — commander gives `color` a default of `true` from the
 * `--no-color` definition, so the *value* alone can't distinguish "auto" from an
 * explicit `--color`; the option's source is what disambiguates.
 */
export function colorFlagFromProgram(program: Command): ColorFlag {
  const source = program.getOptionValueSource?.("color");
  if (source !== "cli") return "auto";
  return program.opts().color ? "always" : "never";
}
