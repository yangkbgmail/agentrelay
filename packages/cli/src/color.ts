// Centralized decision for whether human-facing CLI output should include ANSI
// color/style escapes. Every renderer (`renderStatus`, `renderNext`, …) is a
// pure function that takes a `color` boolean; this module is the single place
// that decides what that boolean should be, so all commands honor the same
// rules instead of each blindly colorizing whenever stdout happens to be a TTY.
//
// Precedence (highest first), documented so scripts and CI can rely on it:
//   1. AGENTRELAY_COLOR=always|never — app-specific hard override ("auto"/other = ignore)
//   2. FORCE_COLOR                    — present & not "0"/"false"/"no"/"off" ⇒ on; falsey ⇒ off
//   3. NO_COLOR                       — present & non-empty ⇒ off  (https://no-color.org)
//   4. otherwise                      — on only when the stream is a TTY
//
// Why this order: an explicit app knob beats generic env vars; between the two
// cross-tool standards an explicit force-on beats a force-off (mirrors
// supports-color/chalk); and TTY auto-detection is the last resort so piping to
// a file or `| jq` stays free of escape codes by default.

/** The subset of environment variables that influence the color decision. */
export interface ColorEnv {
  AGENTRELAY_COLOR?: string;
  FORCE_COLOR?: string;
  NO_COLOR?: string;
}

/** True when a `FORCE_COLOR`-style value should be read as "off" rather than "on". */
function isFalsey(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

/**
 * Decide whether to emit ANSI color, given the environment and whether the
 * output stream is a TTY. Pure — no ambient `process` access — so the entire
 * precedence matrix is unit-testable without spawning a terminal.
 */
export function resolveColorMode(env: ColorEnv, options: { isTTY?: boolean } = {}): boolean {
  const app = env.AGENTRELAY_COLOR?.trim().toLowerCase();
  if (app === "always") return true;
  if (app === "never") return false;
  // "auto" (or any unrecognized value) falls through to the env standards below.

  // supports-color semantics: presence of FORCE_COLOR forces color on unless the
  // value is explicitly falsey; an empty value ("FORCE_COLOR=") still means on.
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    return !isFalsey(force);
  }

  // no-color.org: honor NO_COLOR whenever it is present and non-empty, regardless
  // of its value. An empty string is treated as unset so it cannot silently
  // disable color.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return false;
  }

  return Boolean(options.isTTY);
}

/**
 * The color decision for the process's stdout — the drop-in replacement for the
 * `Boolean(process.stdout.isTTY)` checks previously scattered across the command
 * wiring. Reads the live environment and TTY state at call time.
 */
export function stdoutColor(): boolean {
  return resolveColorMode(process.env, { isTTY: Boolean(process.stdout.isTTY) });
}
