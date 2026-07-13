import type { RetryPolicy } from "./types.js";

/**
 * Retry policy governs two independent failure modes the scheduler can hit
 * when it resumes a queued job:
 *
 *  1. The command hits a rate limit *again* -> the job is re-queued for the
 *     new reset time (the core relay loop). This can bounce indefinitely
 *     across limit windows, so `maxAttempts` caps it to avoid a job that
 *     never terminates.
 *  2. The command fails to run for a transient reason (spawn error, the
 *     child process errored, a non-zero exit with no rate-limit message) ->
 *     instead of failing permanently on the first hiccup, the job is
 *     re-queued with exponential backoff, up to `maxAttempts`.
 *
 * Both modes share the same `attempts` counter and the same cap, so a job's
 * total lifetime work is bounded no matter which failure it keeps hitting.
 */

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  // A generous default: enough to ride out a full day of 5-hour windows, or
  // a run of transient hiccups, without looping forever.
  maxAttempts: 10,
  // 1 minute base, doubling each transient failure, capped at 1 hour.
  baseBackoffMs: 60_000,
  maxBackoffMs: 60 * 60_000,
};

/** Fills in any missing fields from {@link DEFAULT_RETRY_POLICY}. */
export function resolveRetryPolicy(policy?: Partial<RetryPolicy>): RetryPolicy {
  const merged = { ...DEFAULT_RETRY_POLICY, ...(policy ?? {}) };
  // Guard against nonsense that would break the backoff math or disable the cap.
  if (!Number.isFinite(merged.maxAttempts) || merged.maxAttempts < 1) {
    merged.maxAttempts = DEFAULT_RETRY_POLICY.maxAttempts;
  }
  if (!Number.isFinite(merged.baseBackoffMs) || merged.baseBackoffMs < 0) {
    merged.baseBackoffMs = DEFAULT_RETRY_POLICY.baseBackoffMs;
  }
  if (!Number.isFinite(merged.maxBackoffMs) || merged.maxBackoffMs < merged.baseBackoffMs) {
    merged.maxBackoffMs = Math.max(merged.baseBackoffMs, DEFAULT_RETRY_POLICY.maxBackoffMs);
  }
  return merged;
}

/**
 * Exponential backoff delay for a transient failure on the given attempt.
 * `attempt` is 1-based: attempt 1 waits `baseBackoffMs`, attempt 2 waits
 * `2 * baseBackoffMs`, and so on, capped at `maxBackoffMs`.
 */
export function computeBackoffMs(attempt: number, policy: RetryPolicy): number {
  const n = Math.max(1, Math.floor(attempt));
  // 2 ** (n-1) grows fast; clamp the exponent so we never compute Infinity
  // before the Math.min cap kicks in.
  const exponent = Math.min(n - 1, 40);
  const raw = policy.baseBackoffMs * 2 ** exponent;
  return Math.min(raw, policy.maxBackoffMs);
}

/** Whether a job that has used `attempts` attempts is allowed to try again. */
export function canRetry(attempts: number, policy: RetryPolicy): boolean {
  return attempts < policy.maxAttempts;
}
