import { computeBackoffSchedule, type RetryPolicy } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { formatPolicyLine, renderBackoff, renderBackoffJson } from "../src/backoff.js";

const policy: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 60_000,
  factor: 2,
  maxDelayMs: 60 * 60_000,
  jitter: 0,
};

describe("formatPolicyLine", () => {
  it("summarizes the knobs and omits jitter when off", () => {
    const line = formatPolicyLine(computeBackoffSchedule(policy));
    expect(line).toBe("max 5 attempts · base 1m 0s · ×2 · cap 1h 0m");
    expect(line).not.toContain("jitter");
  });

  it("shows the jitter percentage when on", () => {
    const line = formatPolicyLine(computeBackoffSchedule({ ...policy, jitter: 0.2 }));
    expect(line).toContain("jitter ±20%");
  });

  it("labels an unlimited policy", () => {
    const line = formatPolicyLine(computeBackoffSchedule({ ...policy, maxAttempts: 0 }));
    expect(line).toContain("unlimited attempts");
  });
});

describe("renderBackoff", () => {
  it("lists one wait per between-attempt step with the delay and a terminal note", () => {
    const out = renderBackoff(computeBackoffSchedule(policy));
    expect(out).toContain("attempt 1 → wait 1m 0s");
    expect(out).toContain("attempt 4 → wait 8m 0s");
    expect(out).toContain("after attempt 5 the job is marked failed");
    expect(out).toContain("total wait across retries: ~15m 0s");
  });

  it("shows jitter bounds per step and on the total when jitter is on", () => {
    const out = renderBackoff(computeBackoffSchedule({ ...policy, jitter: 0.5 }));
    // attempt 1: 1m -> [30s, 1m 30s]
    expect(out).toContain("(30s – 1m 30s)");
    expect(out).toContain("with jitter");
  });

  it("flags a step pinned at the cap", () => {
    const capped = { ...policy, maxDelayMs: 3 * 60_000 }; // 3m cap; attempt 3 = 4m -> capped
    const out = renderBackoff(computeBackoffSchedule(capped));
    expect(out).toContain("at cap");
  });

  it("notes an unlimited policy shows only the first N", () => {
    const out = renderBackoff(computeBackoffSchedule({ ...policy, maxAttempts: 0 }));
    expect(out).toContain("unlimited attempts — showing the first");
    expect(out).not.toContain("marked failed");
  });

  it("explains when there are no retries at all", () => {
    const out = renderBackoff(computeBackoffSchedule({ ...policy, maxAttempts: 1 }));
    expect(out).toContain("No retries");
    expect(out).not.toContain("attempt 1 → wait");
  });

  it("emits ANSI codes only when color is enabled", () => {
    const plain = renderBackoff(computeBackoffSchedule(policy), { color: false });
    const colored = renderBackoff(computeBackoffSchedule(policy), { color: true });
    expect(plain).not.toContain("\x1b[");
    expect(colored).toContain("\x1b[");
  });
});

describe("renderBackoffJson", () => {
  it("round-trips the full schedule", () => {
    const schedule = computeBackoffSchedule({ ...policy, jitter: 0.2 });
    const parsed = JSON.parse(renderBackoffJson(schedule));
    expect(parsed).toEqual(schedule);
    expect(parsed.steps).toHaveLength(4);
    expect(parsed.policy.jitter).toBe(0.2);
  });
});
