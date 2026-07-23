import { parseDuration } from "./prune.js";

/**
 * Resume-time stagger — spread the resume of jobs that share a rate-limit reset
 * time so they don't all hit the API in the same instant.
 *
 * The problem this solves is distinct from the retry backoff jitter in
 * `retry.ts`. That jitter only spreads *transient-failure* retries (spawn error
 * / non-zero exit). This spreads the *rate-limit reset* itself: when several
 * jobs run against the same account, the parser gives them all the *same*
 * `resetAt`. `listDue` then releases them together, the scheduler resumes them
 * back-to-back in one tick, they all re-hit the limit, all get re-queued with
 * the same new `resetAt`, and the herd relays forever in lockstep. Nudging each
 * job's *effective* resume time by an independent random amount within a small
 * window breaks that lockstep.
 */

/** Default stagger window (ms). 0 disables staggering — deterministic and backward compatible. */
export const DEFAULT_RESUME_STAGGER_MS = 0;

/**
 * Returns `resetAt` pushed forward by a random offset in `[0, staggerMs]`.
 *
 * The offset is only ever *added* (never subtracted), so a staggered job never
 * resumes before its limit has actually reset — it just waits a little longer
 * than the bare minimum, spreading the herd across the window.
 *
 * With `staggerMs <= 0` or no `rng`, `resetAt` is returned unchanged, so the
 * default configuration stays fully deterministic and existing callers/tests
 * are unaffected. An unparseable `resetAt` is also returned as-is (there is
 * nothing sane to offset). `rng` must return a value in `[0, 1)` (e.g.
 * {@link Math.random}); inject a fixed function in tests for determinism.
 */
export function staggerResetAt(resetAt: string, staggerMs: number, rng?: () => number): string {
  if (!rng || !(staggerMs > 0)) return resetAt;
  const base = new Date(resetAt).getTime();
  if (!Number.isFinite(base)) return resetAt;
  const offset = Math.round(rng() * staggerMs);
  if (offset <= 0) return resetAt;
  return new Date(base + offset).toISOString();
}

/**
 * Reads `AGENTRELAY_RESUME_STAGGER` — a duration like `30s`, `2m` or `500ms` —
 * into a stagger window in milliseconds. Unset, blank, unparseable, or
 * non-positive all fall back to {@link DEFAULT_RESUME_STAGGER_MS} (0 = off), so
 * a typo silently disables staggering rather than throwing. A duration string
 * (not a bare number) is used so it reads like the other duration-typed knobs
 * (`AGENTRELAY_AUTOPRUNE_AFTER`/`_EVERY`).
 */
export function resumeStaggerMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENTRELAY_RESUME_STAGGER;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RESUME_STAGGER_MS;
  const ms = parseDuration(raw.trim());
  return ms !== null && ms > 0 ? ms : DEFAULT_RESUME_STAGGER_MS;
}
