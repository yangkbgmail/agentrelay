import type { RetryPolicy } from "./types.js";

/**
 * Default retry policy for failed commands. Deliberately conservative: a few
 * retries with growing backoff so a transient failure (network blip, a flaky
 * agent CLI startup) self-heals, but a genuinely broken command gives up
 * within a couple of minutes instead of spinning forever.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 30_000, // 30s
  maxDelayMs: 5 * 60_000, // 5 min
  factor: 2,
};

/**
 * Computes the backoff delay (ms) before the Nth failure retry, capped at
 * `maxDelayMs`. `retryNumber` is 1-based: the first retry uses `baseDelayMs`,
 * the second `baseDelayMs * factor`, and so on.
 */
export function computeBackoffMs(policy: RetryPolicy, retryNumber: number): number {
  if (retryNumber < 1) return 0;
  const raw = policy.baseDelayMs * Math.pow(policy.factor, retryNumber - 1);
  // Guard against Infinity/NaN from absurd inputs, then clamp to the ceiling.
  if (!Number.isFinite(raw)) return policy.maxDelayMs;
  return Math.min(policy.maxDelayMs, Math.round(raw));
}

/**
 * Whether another failure retry is allowed given how many retries have already
 * been used. `maxRetries <= 0` means unlimited.
 */
export function canRetry(policy: RetryPolicy, retriesUsed: number): boolean {
  if (policy.maxRetries <= 0) return true;
  return retriesUsed < policy.maxRetries;
}

/**
 * Builds a RetryPolicy from environment variables, falling back to the default
 * for any unset/invalid value. Lets `agentrelay daemon`/`tick` be tuned without
 * code changes:
 *   AGENTRELAY_MAX_RETRIES, AGENTRELAY_RETRY_BASE_MS,
 *   AGENTRELAY_RETRY_MAX_MS, AGENTRELAY_RETRY_FACTOR
 */
export function retryPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RetryPolicy {
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === "") return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    maxRetries: num(env.AGENTRELAY_MAX_RETRIES, DEFAULT_RETRY_POLICY.maxRetries),
    baseDelayMs: num(env.AGENTRELAY_RETRY_BASE_MS, DEFAULT_RETRY_POLICY.baseDelayMs),
    maxDelayMs: num(env.AGENTRELAY_RETRY_MAX_MS, DEFAULT_RETRY_POLICY.maxDelayMs),
    factor: num(env.AGENTRELAY_RETRY_FACTOR, DEFAULT_RETRY_POLICY.factor),
  };
}
