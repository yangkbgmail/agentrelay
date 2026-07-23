import { parseDuration } from "./prune.js";

/**
 * Resume stagger — spreads the resume of jobs that share (or nearly share) a
 * rate-limit reset window across a short span, so a batch of jobs that all
 * parked with the same `resetAt` don't wake up in lockstep at the exact instant
 * the window opens and immediately re-hit the same limit together.
 *
 * This is the reset-time analogue of the transient-failure backoff jitter (see
 * `retry.ts`'s `computeBackoffMs`): jitter spreads *retry* delays, stagger
 * spreads *reset-based resumes*. Both fight the same thundering-herd problem
 * from opposite ends of the relay loop.
 *
 * The offset is always **non-negative** — a staggered job resumes at or slightly
 * after the true reset, never before it (resuming early would just re-hit the
 * limit), so the spread can only ever help, never hurt.
 */

/**
 * A random offset in `[0, staggerMs)` milliseconds, or `0` when stagger is
 * disabled. `rng` must return a value in `[0, 1)` (e.g. {@link Math.random}).
 * Pure aside from the injected `rng`, so tests can pin the offset.
 */
export function computeResumeStaggerMs(staggerMs: number, rng: () => number): number {
  if (!(staggerMs > 0)) return 0;
  const offset = Math.floor(rng() * staggerMs);
  // Guard against an rng that returns >=1 or a NaN slipping through.
  if (!Number.isFinite(offset) || offset < 0) return 0;
  return Math.min(offset, staggerMs);
}

/**
 * Returns `resetAtIso` shifted forward by a random offset in `[0, staggerMs)`,
 * so a batch of jobs sharing a reset window resume spread out instead of all at
 * once. Returns the input unchanged when stagger is disabled (`staggerMs <= 0`)
 * or when `resetAtIso` isn't a parseable timestamp (never corrupt a reset the
 * relay still needs to act on). Pure aside from the injected `rng`.
 */
export function applyResumeStagger(resetAtIso: string, staggerMs: number, rng: () => number): string {
  const offset = computeResumeStaggerMs(staggerMs, rng);
  if (offset === 0) return resetAtIso;
  const base = new Date(resetAtIso).getTime();
  if (Number.isNaN(base)) return resetAtIso;
  return new Date(base + offset).toISOString();
}

/**
 * Reads the resume-stagger window (ms) from the environment. Accepts a duration
 * string like `30s`/`2m`/`500ms` via {@link parseDuration}; unset, empty,
 * unparseable, or non-positive all mean "disabled" and yield `0`, so a typo
 * quietly turns stagger off rather than throwing.
 *
 * - `AGENTRELAY_RESUME_STAGGER` (default off; e.g. `30s`, `2m`)
 */
export function resumeStaggerMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENTRELAY_RESUME_STAGGER;
  if (raw === undefined || raw.trim() === "") return 0;
  const ms = parseDuration(raw);
  return ms !== null && ms > 0 ? ms : 0;
}
