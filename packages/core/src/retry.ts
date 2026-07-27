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
  jitter: 0, // deterministic backoff by default
};

/**
 * Exponential backoff delay (ms) before the Nth attempt's retry, 1-indexed:
 * attempt 1 → base, attempt 2 → base·factor, attempt 3 → base·factor², …,
 * clamped to `maxDelayMs`.
 *
 * When `policy.jitter > 0` and a random source `rng` is supplied, the clamped
 * delay is spread uniformly to `[delay·(1 − jitter), delay·(1 + jitter)]` and
 * re-clamped to `[0, maxDelayMs]`, so jobs that fail in lockstep don't retry at
 * the exact same instant. `rng` must return a value in `[0, 1)` (e.g.
 * `Math.random`). Omitting `rng`, or `jitter <= 0`, keeps the result fully
 * deterministic — the spread branch is never entered, so existing callers and
 * tests are unaffected.
 */
export function computeBackoffMs(policy: RetryPolicy, attemptNumber: number, rng?: () => number): number {
  const exponent = Math.max(0, attemptNumber - 1);
  const raw = policy.baseDelayMs * policy.factor ** exponent;
  const base = Number.isFinite(raw) ? Math.min(policy.maxDelayMs, Math.round(raw)) : policy.maxDelayMs;

  const jitter = policy.jitter;
  if (!rng || !(jitter > 0)) return base;

  const fraction = Math.min(1, jitter);
  const lo = base * (1 - fraction);
  const hi = base * (1 + fraction);
  const spread = lo + rng() * (hi - lo);
  return Math.max(0, Math.min(policy.maxDelayMs, Math.round(spread)));
}

/**
 * True when a job has used up its retry budget and should be marked `failed`
 * instead of retried again. `maxAttempts <= 0` means unlimited.
 */
export function isRetryExhausted(policy: RetryPolicy, attemptNumber: number): boolean {
  return policy.maxAttempts > 0 && attemptNumber >= policy.maxAttempts;
}

/** How many backoff steps to preview when the policy is unlimited (`maxAttempts <= 0`). */
export const DEFAULT_BACKOFF_PREVIEW_STEPS = 5;

/**
 * One between-attempt wait in a retry schedule. `attempt` is the 1-indexed
 * attempt *after which* the relay waits `delayMs` before retrying (matching the
 * scheduler: attempt N fails → wait `computeBackoffMs(policy, N)` → attempt
 * N+1). `capped` is true when the uncapped exponential value reached or exceeded
 * `maxDelayMs` (so this and every later step show the ceiling). When the policy
 * has jitter, `jitterLowMs`/`jitterHighMs` carry the `[min, max]` bounds the
 * actual wait can land in; otherwise they are undefined.
 */
export interface BackoffStep {
  attempt: number;
  delayMs: number;
  capped: boolean;
  jitterLowMs?: number;
  jitterHighMs?: number;
}

/**
 * A preview of the exponential-backoff wait sequence a {@link RetryPolicy}
 * produces for *transient* failures (spawn error / non-zero exit that isn't a
 * rate limit). `totalMs` is the sum of the deterministic waits; with jitter,
 * `totalLowMs`/`totalHighMs` bound the total. `unlimited` mirrors the policy's
 * uncapped attempts (`maxAttempts <= 0`), in which case `steps` is a finite
 * preview rather than the full sequence.
 */
export interface BackoffSchedule {
  policy: RetryPolicy;
  steps: BackoffStep[];
  totalMs: number;
  totalLowMs?: number;
  totalHighMs?: number;
  unlimited: boolean;
}

/**
 * Translates a raw {@link RetryPolicy} into the concrete sequence of waits it
 * produces, so users can answer "base 30s, ×3, jitter 0.2 — how long between
 * retries?" *before* a failure happens. Pure: no clock, no randomness, no I/O.
 *
 * Step count:
 * - `options.steps` (a positive integer), when given, is used verbatim — handy
 *   for previewing an unlimited policy or looking past the attempt cap.
 * - otherwise a limited policy (`maxAttempts > 0`) yields `maxAttempts - 1`
 *   waits (the scheduler stops waiting once the attempt cap is hit), and an
 *   unlimited policy yields {@link DEFAULT_BACKOFF_PREVIEW_STEPS}.
 *
 * Delays reuse {@link computeBackoffMs} (jitter off) so the deterministic value
 * matches the scheduler exactly; jitter bounds mirror its spread/re-clamp.
 */
export function computeBackoffSchedule(policy: RetryPolicy, options: { steps?: number } = {}): BackoffSchedule {
  const unlimited = policy.maxAttempts <= 0;

  let count: number;
  if (options.steps !== undefined && Number.isFinite(options.steps) && options.steps > 0) {
    count = Math.floor(options.steps);
  } else if (unlimited) {
    count = DEFAULT_BACKOFF_PREVIEW_STEPS;
  } else {
    count = Math.max(0, policy.maxAttempts - 1);
  }

  const fraction = policy.jitter > 0 ? Math.min(1, policy.jitter) : 0;
  const steps: BackoffStep[] = [];
  let totalMs = 0;
  let totalLowMs = 0;
  let totalHighMs = 0;

  for (let attempt = 1; attempt <= count; attempt++) {
    const exponent = Math.max(0, attempt - 1);
    const raw = policy.baseDelayMs * policy.factor ** exponent;
    const rawRounded = Number.isFinite(raw) ? Math.round(raw) : Number.POSITIVE_INFINITY;
    const delayMs = computeBackoffMs(policy, attempt); // clamped, deterministic (no rng)
    const capped = rawRounded >= policy.maxDelayMs;

    const step: BackoffStep = { attempt, delayMs, capped };
    totalMs += delayMs;

    if (fraction > 0) {
      const low = Math.max(0, Math.round(delayMs * (1 - fraction)));
      const high = Math.min(policy.maxDelayMs, Math.round(delayMs * (1 + fraction)));
      step.jitterLowMs = low;
      step.jitterHighMs = high;
      totalLowMs += low;
      totalHighMs += high;
    }

    steps.push(step);
  }

  const schedule: BackoffSchedule = { policy, steps, totalMs, unlimited };
  if (fraction > 0) {
    schedule.totalLowMs = totalLowMs;
    schedule.totalHighMs = totalHighMs;
  }
  return schedule;
}

function positiveIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Parses a jitter fraction, clamping to `[0, 1]`; unset/invalid → fallback. */
function jitterFractionOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(1, n);
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
 * - `AGENTRELAY_RETRY_JITTER`   (default 0; fraction in [0,1], values >1 clamp to 1)
 */
export function retryPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RetryPolicy {
  const factorRaw = Number(env.AGENTRELAY_RETRY_FACTOR);
  return {
    maxAttempts: positiveIntOr(env.AGENTRELAY_MAX_ATTEMPTS, DEFAULT_RETRY_POLICY.maxAttempts),
    baseDelayMs: positiveIntOr(env.AGENTRELAY_RETRY_BASE_MS, DEFAULT_RETRY_POLICY.baseDelayMs),
    factor: Number.isFinite(factorRaw) && factorRaw >= 1 ? factorRaw : DEFAULT_RETRY_POLICY.factor,
    maxDelayMs: positiveIntOr(env.AGENTRELAY_RETRY_MAX_MS, DEFAULT_RETRY_POLICY.maxDelayMs),
    jitter: jitterFractionOr(env.AGENTRELAY_RETRY_JITTER, DEFAULT_RETRY_POLICY.jitter),
  };
}
