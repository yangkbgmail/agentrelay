import { describe, expect, it } from "vitest";
import {
  computeBackoffMs,
  computeBackoffSchedule,
  DEFAULT_BACKOFF_PREVIEW_STEPS,
  DEFAULT_RETRY_POLICY,
  isRetryExhausted,
  retryPolicyFromEnv,
} from "../src/retry.js";
import type { RetryPolicy } from "../src/types.js";

const policy: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  factor: 2,
  maxDelayMs: 10_000,
  jitter: 0,
};

describe("computeBackoffMs", () => {
  it("grows exponentially from the base delay", () => {
    expect(computeBackoffMs(policy, 1)).toBe(1000);
    expect(computeBackoffMs(policy, 2)).toBe(2000);
    expect(computeBackoffMs(policy, 3)).toBe(4000);
    expect(computeBackoffMs(policy, 4)).toBe(8000);
  });

  it("clamps to maxDelayMs", () => {
    expect(computeBackoffMs(policy, 5)).toBe(10_000); // 16000 clamped
    expect(computeBackoffMs(policy, 50)).toBe(10_000);
  });

  it("treats attempt <= 1 as the base delay (no negative exponent)", () => {
    expect(computeBackoffMs(policy, 0)).toBe(1000);
    expect(computeBackoffMs(policy, -3)).toBe(1000);
  });

  it("stays deterministic when jitter is 0 even if an rng is supplied", () => {
    const rng = () => 0.99; // would move the delay if consulted
    expect(computeBackoffMs(policy, 2, rng)).toBe(2000);
  });

  it("ignores jitter when no rng is supplied", () => {
    const jittered: RetryPolicy = { ...policy, jitter: 0.5 };
    expect(computeBackoffMs(jittered, 2)).toBe(2000);
  });

  it("spreads the delay uniformly across ±jitter when rng is supplied", () => {
    const jittered: RetryPolicy = { ...policy, jitter: 0.5 };
    // base for attempt 2 = 2000; window is [1000, 3000].
    expect(computeBackoffMs(jittered, 2, () => 0)).toBe(1000); // low end
    expect(computeBackoffMs(jittered, 2, () => 0.5)).toBe(2000); // midpoint
    expect(computeBackoffMs(jittered, 2, () => 1)).toBe(3000); // high end
  });

  it("clamps a jittered delay to [0, maxDelayMs]", () => {
    // base attempt 5 = 16000 clamped to 10000; +100% jitter would reach 20000.
    const jittered: RetryPolicy = { ...policy, jitter: 1 };
    expect(computeBackoffMs(jittered, 5, () => 1)).toBe(10_000); // upper clamp
    expect(computeBackoffMs(jittered, 5, () => 0)).toBe(0); // lower end of ±100%
  });

  it("clamps jitter fractions above 1 down to a ±100% spread", () => {
    const overshoot: RetryPolicy = { ...policy, jitter: 5 };
    // attempt 1 base = 1000; ±100% window is [0, 2000], not wider.
    expect(computeBackoffMs(overshoot, 1, () => 0)).toBe(0);
    expect(computeBackoffMs(overshoot, 1, () => 1)).toBe(2000);
  });
});

describe("isRetryExhausted", () => {
  it("is true once attempts reach maxAttempts", () => {
    expect(isRetryExhausted(policy, 4)).toBe(false);
    expect(isRetryExhausted(policy, 5)).toBe(true);
    expect(isRetryExhausted(policy, 6)).toBe(true);
  });

  it("never exhausts when maxAttempts is 0 (unlimited)", () => {
    const unlimited: RetryPolicy = { ...policy, maxAttempts: 0 };
    expect(isRetryExhausted(unlimited, 1000)).toBe(false);
  });
});

describe("retryPolicyFromEnv", () => {
  it("returns the defaults when nothing is set", () => {
    expect(retryPolicyFromEnv({})).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("reads overrides from the environment", () => {
    const p = retryPolicyFromEnv({
      AGENTRELAY_MAX_ATTEMPTS: "3",
      AGENTRELAY_RETRY_BASE_MS: "5000",
      AGENTRELAY_RETRY_FACTOR: "3",
      AGENTRELAY_RETRY_MAX_MS: "120000",
    });
    expect(p).toEqual({ maxAttempts: 3, baseDelayMs: 5000, factor: 3, maxDelayMs: 120_000, jitter: 0 });
  });

  it("falls back to defaults for invalid values", () => {
    const p = retryPolicyFromEnv({
      AGENTRELAY_MAX_ATTEMPTS: "not-a-number",
      AGENTRELAY_RETRY_FACTOR: "0.5", // factor must be >= 1
    });
    expect(p.maxAttempts).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
    expect(p.factor).toBe(DEFAULT_RETRY_POLICY.factor);
  });

  it("accepts 0 for unlimited attempts", () => {
    expect(retryPolicyFromEnv({ AGENTRELAY_MAX_ATTEMPTS: "0" }).maxAttempts).toBe(0);
  });

  it("reads the jitter fraction and clamps it to [0, 1]", () => {
    expect(retryPolicyFromEnv({ AGENTRELAY_RETRY_JITTER: "0.25" }).jitter).toBe(0.25);
    expect(retryPolicyFromEnv({ AGENTRELAY_RETRY_JITTER: "3" }).jitter).toBe(1); // clamp up
    expect(retryPolicyFromEnv({ AGENTRELAY_RETRY_JITTER: "0" }).jitter).toBe(0);
  });

  it("falls back to the default jitter for negative or invalid values", () => {
    expect(retryPolicyFromEnv({ AGENTRELAY_RETRY_JITTER: "-1" }).jitter).toBe(DEFAULT_RETRY_POLICY.jitter);
    expect(retryPolicyFromEnv({ AGENTRELAY_RETRY_JITTER: "nope" }).jitter).toBe(DEFAULT_RETRY_POLICY.jitter);
  });
});

describe("computeBackoffSchedule", () => {
  it("produces maxAttempts - 1 between-attempt waits with the exponential delays", () => {
    const schedule = computeBackoffSchedule(policy); // maxAttempts 5 -> 4 waits
    expect(schedule.unlimited).toBe(false);
    expect(schedule.steps.map((s) => s.attempt)).toEqual([1, 2, 3, 4]);
    expect(schedule.steps.map((s) => s.delayMs)).toEqual([1000, 2000, 4000, 8000]);
    expect(schedule.totalDelayMs).toBe(15_000);
  });

  it("has no jitter bounds and no gaps when jitter is 0 (min = max = delay)", () => {
    const schedule = computeBackoffSchedule(policy);
    for (const step of schedule.steps) {
      expect(step.minDelayMs).toBe(step.delayMs);
      expect(step.maxDelayMs).toBe(step.delayMs);
    }
    expect(schedule.totalMinMs).toBe(schedule.totalDelayMs);
    expect(schedule.totalMaxMs).toBe(schedule.totalDelayMs);
  });

  it("reports jitter as ±fraction bounds matching computeBackoffMs, re-clamped to [0, maxDelayMs]", () => {
    const jittered = { ...policy, jitter: 0.5 };
    const schedule = computeBackoffSchedule(jittered);
    // attempt 1: base 1000 -> [500, 1500]; matches the spread computeBackoffMs applies.
    expect(schedule.steps[0]).toMatchObject({ delayMs: 1000, minDelayMs: 500, maxDelayMs: 1500 });
    expect(computeBackoffMs(jittered, 1, () => 0)).toBe(schedule.steps[0].minDelayMs);
    expect(computeBackoffMs(jittered, 1, () => 1)).toBe(schedule.steps[0].maxDelayMs);
    // attempt 4: base 8000 -> [4000, 12000] but capped to maxDelayMs 10000.
    expect(schedule.steps[3]).toMatchObject({ delayMs: 8000, minDelayMs: 4000, maxDelayMs: 10_000 });
  });

  it("flags steps pinned at the maxDelayMs cap", () => {
    // attempts 1..5 (explicit count) with base 1000 ×2 cap 10000: attempt 5 = 16000 -> capped.
    const schedule = computeBackoffSchedule(policy, { steps: 5 });
    expect(schedule.steps.map((s) => s.capped)).toEqual([false, false, false, false, true]);
    expect(schedule.steps[4].delayMs).toBe(10_000);
  });

  it("previews a fixed number of waits for an unlimited policy", () => {
    const unlimited = { ...policy, maxAttempts: 0 };
    const schedule = computeBackoffSchedule(unlimited);
    expect(schedule.unlimited).toBe(true);
    expect(schedule.steps).toHaveLength(DEFAULT_BACKOFF_PREVIEW_STEPS);
  });

  it("honors an explicit steps override (including past the cap and for unlimited)", () => {
    expect(computeBackoffSchedule(policy, { steps: 2 }).steps).toHaveLength(2);
    expect(computeBackoffSchedule({ ...policy, maxAttempts: 0 }, { steps: 3 }).steps).toHaveLength(3);
  });

  it("yields no waits when the first failure is terminal (maxAttempts <= 1 or steps 0)", () => {
    expect(computeBackoffSchedule({ ...policy, maxAttempts: 1 }).steps).toEqual([]);
    expect(computeBackoffSchedule(policy, { steps: 0 }).steps).toEqual([]);
    const empty = computeBackoffSchedule(policy, { steps: 0 });
    expect(empty.totalDelayMs).toBe(0);
    expect(empty.totalMinMs).toBe(0);
    expect(empty.totalMaxMs).toBe(0);
  });
});
