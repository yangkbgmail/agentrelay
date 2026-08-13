/**
 * ANSI-color enablement resolution shared by every CLI renderer.
 *
 * Until now each command decided color with a bare `Boolean(process.stdout.isTTY)`,
 * which meant the two de-facto conventions users reach for were silently ignored:
 *   - `NO_COLOR` (https://no-color.org/) — set it to strip ANSI from tools that
 *     honor it, even on a TTY (screen readers, plain logs, `less -R` avoidance).
 *   - `FORCE_COLOR` — the inverse, to *keep* color when piping into a pager or a
 *     CI viewer that renders ANSI despite the pipe making `isTTY` false.
 *
 * `resolveColorPreference` reads only the environment and returns an explicit
 * override (`true`/`false`) or `null` when neither variable applies.
 * `shouldUseColor` layers that over the TTY fallback so call sites collapse to a
 * single expression. Pure and env-injectable — no process/global reads baked in.
 */

/** Values of `FORCE_COLOR` that mean "off" (mirrors the `supports-color` convention). */
const FORCE_COLOR_OFF = new Set(["0", "false"]);

/**
 * Resolve the color override implied by the environment, independent of the TTY:
 *   - `FORCE_COLOR` set to anything other than `0`/`false` → force color ON
 *     (takes precedence, matching `supports-color`/`chalk`).
 *   - `FORCE_COLOR` set to `0`/`false` → force color OFF.
 *   - `NO_COLOR` present and non-empty → color OFF.
 *   - otherwise → `null` (no opinion; defer to the TTY).
 *
 * An empty `NO_COLOR` is treated as unset so an accidentally-exported blank var
 * doesn't quietly strip everyone's color; a blank `FORCE_COLOR` still forces on,
 * which is the `supports-color` behavior users expect from `FORCE_COLOR=`.
 */
export function resolveColorPreference(env: Record<string, string | undefined> = process.env): boolean | null {
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    return !FORCE_COLOR_OFF.has(force.trim().toLowerCase());
  }
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return false;
  return null;
}

/**
 * Whether ANSI color should be emitted: the environment override if one applies,
 * otherwise the TTY fallback (`isTTY`). Callers pass `process.stdout.isTTY`.
 */
export function shouldUseColor(env: Record<string, string | undefined> = process.env, isTTY = false): boolean {
  const preference = resolveColorPreference(env);
  return preference ?? isTTY;
}
