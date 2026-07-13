import { describe, expect, it } from "vitest";
import { DEFAULT_RETRY_POLICY, backoffDelayMs } from "../src/retry.js";
import type { RetryPolicy } from "../src/types.js";

describe("backoffDelayMs", () => {
  const policy: RetryPolicy = {
    maxAttempts: 5,
    baseDelayMs: 1000,
    maxDelayMs: 10_000,
    backoffFactor: 2,
  };

  it("grows exponentially with the attempt number (1-based)", () => {
    expect(backoffDelayMs(1, policy)).toBe(1000); // 1000 * 2^0
    expect(backoffDelayMs(2, policy)).toBe(2000); // 1000 * 2^1
    expect(backoffDelayMs(3, policy)).toBe(4000); // 1000 * 2^2
    expect(backoffDelayMs(4, policy)).toBe(8000); // 1000 * 2^3
  });

  it("clamps to maxDelayMs", () => {
    expect(backoffDelayMs(5, policy)).toBe(10_000); // 16000 -> capped
    expect(backoffDelayMs(100, policy)).toBe(10_000);
  });

  it("treats attempt < 1 as the first attempt", () => {
    expect(backoffDelayMs(0, policy)).toBe(1000);
    expect(backoffDelayMs(-3, policy)).toBe(1000);
  });

  it("has sensible built-in defaults", () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeGreaterThan(1);
    expect(backoffDelayMs(1)).toBe(DEFAULT_RETRY_POLICY.baseDelayMs);
    expect(backoffDelayMs(50)).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
  });
});
