import { parseDuration } from "./prune.js";

/**
 * Wall-clock execution limit for a single resumed agent invocation.
 *
 * The scheduler resumes a job by spawning its original command and awaiting the
 * child's exit. A well-behaved agent CLI always exits — either finishing the
 * task or printing a fresh rate-limit line and quitting. But a hung child (a
 * network read that never returns, an agent waiting on stdin that never comes,
 * a deadlocked subprocess) never emits `close`, so the resume promise never
 * settles. With the default serial resume that single stuck process blocks the
 * whole tick: no other due job is ever picked up, the daemon's liveness
 * heartbeat stops advancing, and the relay silently stalls indefinitely — the
 * exact "silent failure" class AgentRelay exists to prevent.
 *
 * A max-runtime bound closes that gap: a resume that runs longer than the limit
 * is killed and surfaced as a transient failure, so the retry policy takes over
 * and the rest of the queue keeps moving.
 *
 * Unlike the reset-horizon guard, this is **OFF by default**. A legitimate
 * agent run can take arbitrarily long, and killing it blindly would throw away
 * real work; the bound is opt-in for setups that know their invocations should
 * finish within a known window and that an overrun means "stuck".
 *
 * `AGENTRELAY_MAX_RUNTIME` accepts any {@link parseDuration} string
 * (`30m`, `2h`, `90s`, `500ms`, …). Unset/empty, an explicit
 * `0`/`off`/`none`/`disabled`/`no`, or an unparseable/non-positive value all
 * mean "no limit" (`null`) — so a typo can never silently start killing agent
 * runs; the guard only engages on a clearly-intended positive duration.
 */
export function maxRuntimeMsFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.AGENTRELAY_MAX_RUNTIME?.trim();
  if (raw === undefined || raw === "") return null;
  if (/^(0|off|none|disabled|no)$/i.test(raw)) return null;
  const parsed = parseDuration(raw);
  return parsed !== null && parsed > 0 ? parsed : null;
}

/**
 * Normalize a `maxRuntimeMs` scheduler option to a positive finite number of
 * milliseconds, or `null` (guard off). Non-numbers, `NaN`/`Infinity`, zero, and
 * negatives all collapse to `null`, mirroring {@link maxRuntimeMsFromEnv} so the
 * option and the env var behave identically. Pure.
 */
export function normalizeMaxRuntimeMs(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
