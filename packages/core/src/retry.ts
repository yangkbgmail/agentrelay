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

/** Fallback number of waits previewed for an unlimited (`maxAttempts <= 0`) policy. */
export const DEFAULT_BACKOFF_PREVIEW_STEPS = 5;

/** One between-attempt wait in a previewed backoff schedule. */
export interface BackoffStep {
  /**
   * 1-indexed number of the attempt that just failed and triggers this wait.
   * The scheduler backs off for attempts `1 .. maxAttempts - 1` (the wait after
   * the final attempt never happens — `isRetryExhausted` fires first), so the
   * wait for `attempt` precedes attempt `attempt + 1`.
   */
  attempt: number;
  /** Deterministic (mid-point) delay before the next attempt, in ms. */
  delayMs: number;
  /** Jitter lower bound in ms (equals `delayMs` when `jitter` is 0). */
  minDelayMs: number;
  /** Jitter upper bound in ms (equals `delayMs` when `jitter` is 0). */
  maxDelayMs: number;
  /** True when this wait is pinned at the policy's `maxDelayMs` cap. */
  capped: boolean;
}

/** The concrete backoff schedule a {@link RetryPolicy} produces, ready to render. */
export interface BackoffSchedule {
  /** The policy the schedule was computed from. */
  policy: RetryPolicy;
  /** True when `maxAttempts <= 0` (no attempt cap; the preview count is bounded). */
  unlimited: boolean;
  /** One entry per between-attempt wait, in order. */
  steps: BackoffStep[];
  /** Sum of every step's `delayMs`. */
  totalDelayMs: number;
  /** Sum of every step's `minDelayMs`. */
  totalMinMs: number;
  /** Sum of every step's `maxDelayMs`. */
  totalMaxMs: number;
}

/**
 * Expands a {@link RetryPolicy} into the concrete sequence of between-attempt
 * waits it produces, so `config show`'s raw knobs (base / factor / cap / jitter
 * / maxAttempts) can be previewed as the delays a job would actually experience.
 *
 * Pure: no clock, no I/O, no randomness — jitter is reported as the `[min, max]`
 * bounds `computeBackoffMs` would spread each delay across, not a sampled value.
 *
 * The number of waits mirrors the scheduler: a capped policy (`maxAttempts > 0`)
 * backs off for attempts `1 .. maxAttempts - 1`; an unlimited policy has no
 * natural end, so it previews {@link DEFAULT_BACKOFF_PREVIEW_STEPS} waits.
 * `options.steps` overrides the count explicitly (values `<= 0` yield none),
 * which is what lets callers preview an unlimited policy or look past the cap.
 */
export function computeBackoffSchedule(policy: RetryPolicy, options: { steps?: number } = {}): BackoffSchedule {
  const unlimited = policy.maxAttempts <= 0;
  const capWaits = unlimited ? DEFAULT_BACKOFF_PREVIEW_STEPS : Math.max(0, policy.maxAttempts - 1);

  const requested = options.steps;
  const count =
    requested === undefined ? capWaits : Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;

  const fraction = Math.min(1, Math.max(0, policy.jitter));

  const steps: BackoffStep[] = [];
  let totalDelayMs = 0;
  let totalMinMs = 0;
  let totalMaxMs = 0;
  for (let attempt = 1; attempt <= count; attempt++) {
    const delayMs = computeBackoffMs(policy, attempt); // deterministic clamped base
    let minDelayMs = delayMs;
    let maxDelayMs = delayMs;
    if (fraction > 0) {
      // Mirror the spread computeBackoffMs applies (base·(1±fraction), re-clamped).
      minDelayMs = Math.max(0, Math.min(policy.maxDelayMs, Math.round(delayMs * (1 - fraction))));
      maxDelayMs = Math.min(policy.maxDelayMs, Math.round(delayMs * (1 + fraction)));
    }
    steps.push({ attempt, delayMs, minDelayMs, maxDelayMs, capped: delayMs >= policy.maxDelayMs });
    totalDelayMs += delayMs;
    totalMinMs += minDelayMs;
    totalMaxMs += maxDelayMs;
  }

  return { policy, unlimited, steps, totalDelayMs, totalMinMs, totalMaxMs };
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
