import { describe, expect, it } from "vitest";
import { computeBackoffMs, DEFAULT_RETRY_POLICY, isRetryExhausted, retryPolicyFromEnv } from "../src/retry.js";
import type { RetryPolicy } from "../src/types.js";

const policy: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  factor: 2,
  maxDelayMs: 10_000,
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
    expect(p).toEqual({ maxAttempts: 3, baseDelayMs: 5000, factor: 3, maxDelayMs: 120_000 });
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
});
