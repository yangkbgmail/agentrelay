import { parseDuration } from "./prune.js";

/**
 * "Max wait" cap for `agentrelay run`: an optional upper bound on how far into
 * the future a detected rate-limit reset may be before AgentRelay refuses to
 * queue the command for auto-resume.
 *
 * Why: the default relay behaviour is to wait however long the reset needs —
 * great for a laptop left running, but a footgun for CI/automation. A weekly
 * usage limit can reset 18+ hours out, and silently pinning a runner (or a
 * human's terminal) for that long is rarely what you want. With `--max-wait 6h`
 * (or `AGENTRELAY_MAX_WAIT=6h`), a reset beyond the cap is *not* queued; the
 * command's own (non-zero) exit code stands so the caller decides what to do.
 *
 * All logic here is pure so it can be unit-tested without a clock or the store.
 */

/**
 * Read `AGENTRELAY_MAX_WAIT` (a duration like `"6h"` / `"2d"` / `"30m"`) into
 * milliseconds. Returns `null` when the var is unset, blank, unparseable, or
 * non-positive — i.e. "no cap, wait however long the reset needs".
 *
 * The env var is deliberately lenient: a typo falls back to the (safe, existing)
 * unlimited-wait default rather than hard-failing every `run`. The explicit
 * `--max-wait` flag is validated strictly by the CLI instead (it exits non-zero
 * on a bad value), so an interactive user gets told, while a stray env var can't
 * break automation.
 */
export function maxWaitMsFromEnv(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.AGENTRELAY_MAX_WAIT?.trim();
  if (!raw) return null;
  const ms = parseDuration(raw);
  return ms !== null && ms > 0 ? ms : null;
}

/**
 * True when a rate-limit reset at `resetAtIso` is further out than `maxWaitMs`
 * from `nowMs` — meaning the wait exceeds the user's cap and the job should
 * *not* be queued for auto-resume.
 *
 * - A `null`/`undefined` cap means "no cap": nothing ever exceeds it (`false`).
 * - An unparseable `resetAtIso` is treated as exceeding the cap (`true`): if we
 *   can't confirm the reset falls inside the window, a command we can't schedule
 *   sanely shouldn't silently wait. (In practice the parser always yields a
 *   valid ISO string, so this is a defensive guard.)
 * - A reset exactly at the cap (`reset - now === maxWaitMs`) is within it
 *   (`false`); only a *strictly* larger wait is rejected.
 */
export function exceedsMaxWait(resetAtIso: string, nowMs: number, maxWaitMs: number | null | undefined): boolean {
  if (maxWaitMs === null || maxWaitMs === undefined) return false;
  const reset = Date.parse(resetAtIso);
  if (Number.isNaN(reset)) return true;
  return reset - nowMs > maxWaitMs;
}
