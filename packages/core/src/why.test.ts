import { describe, expect, it } from "vitest";
import { DEFAULT_RETRY_POLICY } from "./retry.js";
import type { RateLimitDetection, RelayJob, RetryPolicy } from "./types.js";
import { explainJob } from "./why.js";

const NOW = Date.parse("2026-07-30T12:00:00.000Z");

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq.toString().padStart(8, "0")}`,
    project: "proj",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "waiting_for_reset",
    resetAt: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const detection: RateLimitDetection = {
  pattern: "clock-time",
  rawMatch: "resets at 5:30pm",
  resetAt: "2026-07-30T17:30:00.000Z",
  detectedAt: "2026-07-30T11:00:00.000Z",
};

describe("explainJob", () => {
  it("queued: awaiting next tick, no scheduled resume", () => {
    const e = explainJob(job({ status: "queued" }), { now: NOW, retryPolicy: DEFAULT_RETRY_POLICY });
    expect(e.disposition).toBe("queued");
    expect(e.resumesInMs).toBeNull();
    expect(e.headline).toMatch(/Queued/);
    expect(e.nextAction).toMatch(/agentrelay (health|daemon)/);
  });

  it("waiting with a future reset: reports countdown and provenance", () => {
    const e = explainJob(
      job({ status: "waiting_for_reset", resetAt: "2026-07-30T17:30:00.000Z", lastRateLimit: detection }),
      { now: NOW, retryPolicy: DEFAULT_RETRY_POLICY }
    );
    expect(e.disposition).toBe("waiting");
    expect(e.resumesInMs).toBe(Date.parse("2026-07-30T17:30:00.000Z") - NOW);
    expect(e.reasons.some((r) => r.includes("clock-time") && r.includes("resets at 5:30pm"))).toBe(true);
    expect(e.nextAction).toMatch(/agentrelay retry/);
  });

  it("waiting past its reset: disposition due, resumesInMs 0", () => {
    const e = explainJob(job({ status: "waiting_for_reset", resetAt: "2026-07-30T09:00:00.000Z" }), {
      now: NOW,
      retryPolicy: DEFAULT_RETRY_POLICY,
    });
    expect(e.disposition).toBe("due");
    expect(e.resumesInMs).toBe(0);
    expect(e.headline).toMatch(/Due now/);
    expect(e.nextAction).toMatch(/agentrelay (health|daemon)/);
    expect(e.reasons.some((r) => r.includes("has already passed"))).toBe(true);
  });

  it("waiting with no reset time is treated as due", () => {
    const e = explainJob(job({ status: "waiting_for_reset", resetAt: null }), { now: NOW });
    expect(e.disposition).toBe("due");
    expect(e.resumesInMs).toBe(0);
    expect(e.reasons.some((r) => r.includes("No reset time"))).toBe(true);
  });

  it("resuming: in-flight, suggests wait", () => {
    const e = explainJob(job({ status: "resuming", id: "abcd1234ef" }), { now: NOW });
    expect(e.disposition).toBe("resuming");
    expect(e.resumesInMs).toBeNull();
    expect(e.nextAction).toMatch(/agentrelay wait abcd1234/);
  });

  it("completed: nothing to do", () => {
    const e = explainJob(job({ status: "completed", attempts: 2 }), { now: NOW, retryPolicy: DEFAULT_RETRY_POLICY });
    expect(e.disposition).toBe("completed");
    expect(e.nextAction).toBe("Nothing to do.");
    expect(e.reasons).toContain("Attempt 2 of 5.");
  });

  it("failed with exhausted budget: reports exhaustion + first error line", () => {
    const e = explainJob(job({ status: "failed", attempts: 5, lastError: "\n  boom: exit 1\nstack trace...\n" }), {
      now: NOW,
      retryPolicy: DEFAULT_RETRY_POLICY,
    });
    expect(e.disposition).toBe("failed");
    expect(e.retryExhausted).toBe(true);
    expect(e.reasons.some((r) => r.includes("Exhausted the retry budget"))).toBe(true);
    expect(e.reasons).toContain("Last error: boom: exit 1");
    expect(e.nextAction).toMatch(/agentrelay retry/);
  });

  it("failed under an unlimited policy: no exhaustion, maxAttempts null", () => {
    const unlimited: RetryPolicy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 0 };
    const e = explainJob(job({ status: "failed", attempts: 9 }), { now: NOW, retryPolicy: unlimited });
    expect(e.maxAttempts).toBeNull();
    expect(e.retryExhausted).toBe(false);
    expect(e.reasons).toContain("Attempt 9 (no retry cap).");
  });

  it("cancelled: suggests requeue", () => {
    const e = explainJob(job({ status: "cancelled" }), { now: NOW });
    expect(e.disposition).toBe("cancelled");
    expect(e.nextAction).toMatch(/agentrelay retry/);
  });

  it("without a retry policy: retryExhausted false, maxAttempts null", () => {
    const e = explainJob(job({ status: "failed", attempts: 99 }), { now: NOW });
    expect(e.retryExhausted).toBe(false);
    expect(e.maxAttempts).toBeNull();
  });
});
