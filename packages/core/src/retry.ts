import type { RetryPolicy } from "./types.js";

/**
 * Default retry policy for the scheduler.
 *
 * Rationale:
 * - `maxAttempts: 5` protects against runaway loops (a job that re-triggers a
 *   rate limit on every resume, or a command that crashes every time) while
 *   still being generous enough for a normal multi-window relay. Set to 0 to
 *   disable the cap for genuinely long-running tasks.
 * - Exponential backoff (1m → 2m → 4m → …, capped at 1h) is only applied to
 *   *transient* failures (spawn error / non-zero exit that isn't a rate limit).
 *   Rate-limit re-queues use the parsed reset time instead — there's no point
 *   retrying before the window actually resets.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 60_000, // 1 minute
  factor: 2,
  maxDelayMs: 60 * 60_000, // 1 hour cap
};

/**
 * Exponential backoff delay (ms) before the Nth attempt's retry, 1-indexed:
 * attempt 1 → base, attempt 2 → base·factor, attempt 3 → base·factor², …,
 * clamped to `maxDelayMs`.
 */
export function computeBackoffMs(policy: RetryPolicy, attemptNumber: number): number {
  const exponent = Math.max(0, attemptNumber - 1);
  const raw = policy.baseDelayMs * policy.factor ** exponent;
  if (!Number.isFinite(raw)) return policy.maxDelayMs;
  return Math.min(policy.maxDelayMs, Math.round(raw));
}

/**
 * True when a job has used up its retry budget and should be marked `failed`
 * instead of retried again. `maxAttempts <= 0` means unlimited.
 */
export function isRetryExhausted(policy: RetryPolicy, attemptNumber: number): boolean {
  return policy.maxAttempts > 0 && attemptNumber >= policy.maxAttempts;
}

function positiveIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Builds a {@link RetryPolicy} from environment variables, falling back to
 * {@link DEFAULT_RETRY_POLICY} for anything unset or invalid. Lets users tune
 * the relay without code changes:
 *
 * - `AGENTRELAY_MAX_ATTEMPTS`   (default 5; 0 = unlimited)
 * - `AGENTRELAY_RETRY_BASE_MS`  (default 60000)
 * - `AGENTRELAY_RETRY_FACTOR`   (default 2)
 * - `AGENTRELAY_RETRY_MAX_MS`   (default 3600000)
 */
export function retryPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RetryPolicy {
  const factorRaw = Number(env.AGENTRELAY_RETRY_FACTOR);
  return {
    maxAttempts: positiveIntOr(env.AGENTRELAY_MAX_ATTEMPTS, DEFAULT_RETRY_POLICY.maxAttempts),
    baseDelayMs: positiveIntOr(env.AGENTRELAY_RETRY_BASE_MS, DEFAULT_RETRY_POLICY.baseDelayMs),
    factor: Number.isFinite(factorRaw) && factorRaw >= 1 ? factorRaw : DEFAULT_RETRY_POLICY.factor,
    maxDelayMs: positiveIntOr(env.AGENTRELAY_RETRY_MAX_MS, DEFAULT_RETRY_POLICY.maxDelayMs),
  };
}
