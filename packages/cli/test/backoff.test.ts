import type { RetryPolicy } from "@agentrelay/core";
import { computeBackoffSchedule } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { formatPolicyLine, NO_RETRY_MESSAGE, renderBackoff, renderBackoffJson } from "../src/backoff.js";

const policy: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 60_000, // 1m
  factor: 2,
  maxDelayMs: 60 * 60_000, // 1h
  jitter: 0,
};

describe("formatPolicyLine", () => {
  it("summarizes the raw policy knobs without a jitter clause when jitter is off", () => {
    const line = formatPolicyLine(policy);
    expect(line).toContain("max 5 attempts");
    expect(line).toContain("base 1m 0s");
    expect(line).toContain("×2");
    expect(line).toContain("cap 1h 0m");
    expect(line).not.toContain("jitter");
  });

  it("shows unlimited attempts and a jitter percentage when active", () => {
    const line = formatPolicyLine({ ...policy, maxAttempts: 0, jitter: 0.2 });
    expect(line).toContain("unlimited attempts");
    expect(line).toContain("jitter 20%");
  });
});

describe("renderBackoff", () => {
  it("renders one line per between-attempt wait plus the total", () => {
    const out = renderBackoff(computeBackoffSchedule(policy));
    expect(out).toContain("attempt 1 → wait 1m 0s");
    expect(out).toContain("attempt 2 → wait 2m 0s");
    expect(out).toContain("attempt 3 → wait 4m 0s");
    expect(out).toContain("attempt 4 → wait 8m 0s");
    expect(out).toContain("after attempt 5 the job is marked failed");
    expect(out).toContain("total wait across retries: ~15m 0s");
  });

  it("marks capped steps and notes an unlimited series", () => {
    const out = renderBackoff(computeBackoffSchedule({ ...policy, maxAttempts: 0 }, { steps: 8 }));
    expect(out).toContain("(capped)");
    expect(out).toContain("unlimited attempts — schedule continues, capped");
  });

  it("shows [min – max] ranges for each step and the total when jitter is on", () => {
    const out = renderBackoff(computeBackoffSchedule({ ...policy, jitter: 0.5 }));
    // 1m 0s ± 50% → 30s – 1m 30s
    expect(out).toContain("attempt 1 → wait 30s – 1m 30s");
    expect(out).toMatch(/total wait across retries: ~.+ – .+/);
  });

  it("explains a no-retry policy (maxAttempts 1) instead of an empty list", () => {
    const out = renderBackoff(computeBackoffSchedule({ ...policy, maxAttempts: 1 }));
    expect(out).toContain(NO_RETRY_MESSAGE);
    expect(out).not.toContain("attempt 1 → wait");
  });

  it("gates ANSI color codes behind the color option", () => {
    const plain = renderBackoff(computeBackoffSchedule(policy), { color: false });
    const colored = renderBackoff(computeBackoffSchedule(policy), { color: true });
    expect(plain).not.toContain("\x1b[");
    expect(colored).toContain("\x1b[");
  });
});

describe("renderBackoffJson", () => {
  it("round-trips the schedule shape", () => {
    const schedule = computeBackoffSchedule(policy);
    const parsed = JSON.parse(renderBackoffJson(schedule, "2026-07-27T00:00:00.000Z"));
    expect(parsed.generatedAt).toBe("2026-07-27T00:00:00.000Z");
    expect(parsed.schedule.steps).toHaveLength(4);
    expect(parsed.schedule.totalMs).toBe(schedule.totalMs);
    expect(parsed.schedule.unlimited).toBe(false);
  });
});
