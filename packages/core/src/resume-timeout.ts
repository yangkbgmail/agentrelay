/**
 * Resume watchdog — a hard wall-clock cap on how long a single resumed agent
 * process may run before the scheduler kills it.
 *
 * Without this, {@link RelayScheduler.runCommand} awaits the child's `close`
 * event with no upper bound: if a resumed agent CLI wedges (a hung network
 * call, an interactive prompt no one answers, an infinite loop), that one
 * `resume()` never resolves and the whole relay loop stalls behind it —
 * every other due job waits forever, and `agentrelay doctor`'s heartbeat is
 * the only hint anything is wrong. A watchdog turns "silently stuck forever"
 * into "killed and retried per the retry policy", which is the same graceful
 * path a crashing or spawn-failing resume already takes.
 *
 * Kept off by default (0 = disabled): most resumes are legitimately
 * long-running agent sessions, so a timeout only exists when the operator
 * opts in. Env parsing accepts a human duration (`30m`, `2h`, `90s`) via
 * {@link parseDuration}; an unset / blank / unparseable / non-positive value
 * disables the watchdog rather than picking a surprise default, so a typo can
 * never silently start killing long agent runs.
 */

import { parseDuration } from "./prune.js";

/** Disabled — await the resumed child forever, the historical behavior. */
export const DEFAULT_RESUME_TIMEOUT_MS = 0;

/**
 * Clamp a requested resume-timeout to a non-negative integer number of
 * milliseconds, falling back to {@link DEFAULT_RESUME_TIMEOUT_MS} (disabled)
 * for anything unusable (undefined, NaN, Infinity, zero, or negative).
 * Fractional values floor (1500.9 → 1500). Pure and separate so the parsing
 * rules are unit-testable without a scheduler.
 */
export function normalizeResumeTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_RESUME_TIMEOUT_MS;
  const n = Math.floor(value);
  return n > 0 ? n : DEFAULT_RESUME_TIMEOUT_MS;
}

/**
 * Read `AGENTRELAY_RESUME_TIMEOUT` from the environment as a human duration
 * (`30m`, `2h`, `90s`, `500ms`). Unset, blank, unparseable, or non-positive
 * values disable the watchdog ({@link DEFAULT_RESUME_TIMEOUT_MS}) so a typo
 * never silently kills a legitimately long agent run — it just keeps the safe
 * "wait forever" behavior. Returns the timeout in milliseconds.
 */
export function resumeTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENTRELAY_RESUME_TIMEOUT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RESUME_TIMEOUT_MS;
  const ms = parseDuration(raw);
  if (ms === null) return DEFAULT_RESUME_TIMEOUT_MS;
  return normalizeResumeTimeoutMs(ms);
}
