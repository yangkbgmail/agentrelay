import { describe, expect, it } from "vitest";
import { canReschedule, RESCHEDULABLE_STATUSES, resolveRescheduleAt } from "../src/reschedule.js";
import type { JobStatus, RelayJob } from "../src/types.js";

function job(status: JobStatus): RelayJob {
  const now = "2026-07-13T00:00:00.000Z";
  return {
    id: "job-1",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status,
    resetAt: null,
    createdAt: now,
    updatedAt: now,
    attempts: 2,
    lastError: null,
    lastOutputTail: null,
  };
}

describe("canReschedule", () => {
  it("allows queued and waiting_for_reset jobs", () => {
    for (const status of RESCHEDULABLE_STATUSES) {
      expect(canReschedule(job(status)).ok).toBe(true);
    }
  });

  it("rejects an in-flight (resuming) job", () => {
    const result = canReschedule(job("resuming"));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("resuming");
  });

  it("rejects terminal jobs with a reason", () => {
    for (const status of ["completed", "failed", "cancelled"] as JobStatus[]) {
      const result = canReschedule(job(status));
      expect(result.ok).toBe(false);
      expect(result.reason).toBeTruthy();
    }
  });
});

describe("resolveRescheduleAt", () => {
  // Anchor every relative/`now` case to a fixed instant so the result is exact.
  const nowMs = Date.parse("2026-07-30T12:00:00.000Z");

  it("resolves `now` (any case) to the anchor instant", () => {
    expect(resolveRescheduleAt("now", nowMs).resetAt).toBe("2026-07-30T12:00:00.000Z");
    expect(resolveRescheduleAt("  NOW  ", nowMs).resetAt).toBe("2026-07-30T12:00:00.000Z");
  });

  it("adds a `+<duration>` offset to the anchor", () => {
    expect(resolveRescheduleAt("+30m", nowMs).resetAt).toBe("2026-07-30T12:30:00.000Z");
    expect(resolveRescheduleAt("+2h", nowMs).resetAt).toBe("2026-07-30T14:00:00.000Z");
    expect(resolveRescheduleAt("+90s", nowMs).resetAt).toBe("2026-07-30T12:01:30.000Z");
    expect(resolveRescheduleAt("+1d", nowMs).resetAt).toBe("2026-07-31T12:00:00.000Z");
  });

  it("normalises an absolute ISO 8601 timestamp", () => {
    const result = resolveRescheduleAt("2026-07-30T15:00:00Z", nowMs);
    expect(result.error).toBeUndefined();
    expect(result.resetAt).toBe("2026-07-30T15:00:00.000Z");
  });

  it("errors on an empty token", () => {
    const result = resolveRescheduleAt("   ", nowMs);
    expect(result.resetAt).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  it("errors on a `+<duration>` with an unknown unit", () => {
    const result = resolveRescheduleAt("+5years", nowMs);
    expect(result.resetAt).toBeUndefined();
    expect(result.error).toContain("duration");
  });

  it("errors on a bare duration missing the leading `+`", () => {
    const result = resolveRescheduleAt("30m", nowMs);
    expect(result.resetAt).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  it("errors on unparseable garbage", () => {
    const result = resolveRescheduleAt("whenever", nowMs);
    expect(result.resetAt).toBeUndefined();
    expect(result.error).toBeTruthy();
  });
});
