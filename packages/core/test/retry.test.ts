import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_POLICY,
  canRetry,
  computeBackoffMs,
  resolveRetryPolicy,
} from "../src/retry.js";

describe("resolveRetryPolicy", () => {
  it("returns the defaults when nothing is provided", () => {
    expect(resolveRetryPolicy()).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("merges partial overrides over the defaults", () => {
    const policy = resolveRetryPolicy({ maxAttempts: 3 });
    expect(policy.maxAttempts).toBe(3);
    expect(policy.baseBackoffMs).toBe(DEFAULT_RETRY_POLICY.baseBackoffMs);
  });

  it("rejects a maxAttempts below 1 and falls back to the default", () => {
    expect(resolveRetryPolicy({ maxAttempts: 0 }).maxAttempts).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
    expect(resolveRetryPolicy({ maxAttempts: -5 }).maxAttempts).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
    expect(resolveRetryPolicy({ maxAttempts: NaN }).maxAttempts).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
  });

  it("keeps maxBackoffMs at least as large as baseBackoffMs", () => {
    const policy = resolveRetryPolicy({ baseBackoffMs: 10_000, maxBackoffMs: 500 });
    expect(policy.maxBackoffMs).toBeGreaterThanOrEqual(policy.baseBackoffMs);
  });
});

describe("computeBackoffMs", () => {
  const policy = resolveRetryPolicy({ baseBackoffMs: 1000, maxBackoffMs: 60_000 });

  it("doubles the delay on each successive attempt", () => {
    expect(computeBackoffMs(1, policy)).toBe(1000);
    expect(computeBackoffMs(2, policy)).toBe(2000);
    expect(computeBackoffMs(3, policy)).toBe(4000);
    expect(computeBackoffMs(4, policy)).toBe(8000);
  });

  it("caps the delay at maxBackoffMs", () => {
    expect(computeBackoffMs(20, policy)).toBe(60_000);
  });

  it("never overflows to Infinity for a huge attempt count", () => {
    expect(Number.isFinite(computeBackoffMs(10_000, policy))).toBe(true);
    expect(computeBackoffMs(10_000, policy)).toBe(60_000);
  });
});

describe("canRetry", () => {
  const policy = resolveRetryPolicy({ maxAttempts: 3 });

  it("allows attempts below the cap and blocks at/after it", () => {
    expect(canRetry(0, policy)).toBe(true);
    expect(canRetry(2, policy)).toBe(true);
    expect(canRetry(3, policy)).toBe(false);
    expect(canRetry(4, policy)).toBe(false);
  });
});
