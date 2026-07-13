import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_POLICY,
  canRetry,
  computeBackoffMs,
  retryPolicyFromEnv,
} from "../src/retry.js";
import type { RetryPolicy } from "../src/types.js";

const policy: RetryPolicy = {
  maxRetries: 4,
  baseDelayMs: 1000,
  maxDelayMs: 10_000,
  factor: 2,
};

describe("computeBackoffMs", () => {
  it("grows exponentially by the factor from the base delay", () => {
    expect(computeBackoffMs(policy, 1)).toBe(1000); // 1000 * 2^0
    expect(computeBackoffMs(policy, 2)).toBe(2000); // 1000 * 2^1
    expect(computeBackoffMs(policy, 3)).toBe(4000); // 1000 * 2^2
  });

  it("caps the delay at maxDelayMs", () => {
    expect(computeBackoffMs(policy, 4)).toBe(8000); // 1000 * 2^3
    expect(computeBackoffMs(policy, 5)).toBe(10_000); // would be 16000, capped
    expect(computeBackoffMs(policy, 20)).toBe(10_000);
  });

  it("returns 0 for a non-positive retry number", () => {
    expect(computeBackoffMs(policy, 0)).toBe(0);
    expect(computeBackoffMs(policy, -3)).toBe(0);
  });

  it("does not overflow to Infinity for absurd retry numbers", () => {
    expect(computeBackoffMs(policy, 5000)).toBe(policy.maxDelayMs);
  });
});

describe("canRetry", () => {
  it("allows retries below the max", () => {
    expect(canRetry(policy, 0)).toBe(true);
    expect(canRetry(policy, 3)).toBe(true);
  });

  it("stops at the max", () => {
    expect(canRetry(policy, 4)).toBe(false);
    expect(canRetry(policy, 5)).toBe(false);
  });

  it("treats maxRetries <= 0 as unlimited", () => {
    const unlimited: RetryPolicy = { ...policy, maxRetries: 0 };
    expect(canRetry(unlimited, 999)).toBe(true);
  });
});

describe("retryPolicyFromEnv", () => {
  it("falls back to the default policy when nothing is set", () => {
    expect(retryPolicyFromEnv({})).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("reads valid overrides from the environment", () => {
    const result = retryPolicyFromEnv({
      AGENTRELAY_MAX_RETRIES: "7",
      AGENTRELAY_RETRY_BASE_MS: "500",
      AGENTRELAY_RETRY_MAX_MS: "60000",
      AGENTRELAY_RETRY_FACTOR: "3",
    });
    expect(result).toEqual({ maxRetries: 7, baseDelayMs: 500, maxDelayMs: 60000, factor: 3 });
  });

  it("ignores invalid/blank values and keeps the default", () => {
    const result = retryPolicyFromEnv({
      AGENTRELAY_MAX_RETRIES: "not-a-number",
      AGENTRELAY_RETRY_BASE_MS: "   ",
    });
    expect(result.maxRetries).toBe(DEFAULT_RETRY_POLICY.maxRetries);
    expect(result.baseDelayMs).toBe(DEFAULT_RETRY_POLICY.baseDelayMs);
  });
});
