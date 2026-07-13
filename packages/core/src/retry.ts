import type { RetryPolicy } from "./types.js";

/**
 * Retry policy for the relay loop. Two distinct kinds of "retry" exist:
 *
 *  1. **Rate-limit re-queue** — the resumed command hit a usage limit again.
 *     The next attempt time comes from the parsed reset timestamp, NOT from
 *     backoff. Backoff would be wrong here (we know exactly when the window
 *     reopens). We only apply `maxAttempts` so a permanently-limited job
 *     eventually gives up instead of looping forever.
 *
 *  2. **Transient failure** — the command exited non-zero (crash, network
 *     blip, spawn error) without any rate-limit message. Here we DON'T know
 *     when to retry, so we use exponential backoff, capped at `maxAttempts`.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 60_000, // 1 minute
  maxDelayMs: 60 * 60_000, // 1 hour ceiling on a single backoff wait
  backoffFactor: 2,
};

/**
 * Exponential backoff delay for a given attempt number (1-based: the first
 * retry is attempt 1). Grows as `base * factor^(attempt-1)`, clamped to
 * `[0, maxDelayMs]`. Deterministic (no jitter) so the dashboard countdown and
 * tests stay predictable; a local single-user relay has no thundering-herd
 * problem that jitter would solve.
 */
export function backoffDelayMs(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = policy.baseDelayMs * Math.pow(policy.backoffFactor, n - 1);
  if (!Number.isFinite(raw) || raw < 0) return policy.maxDelayMs;
  return Math.min(raw, policy.maxDelayMs);
}
