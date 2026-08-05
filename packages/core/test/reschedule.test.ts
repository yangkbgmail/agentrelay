import { describe, expect, it } from "vitest";
import { canReschedule, RESCHEDULABLE_STATUSES, resolveRescheduleTime } from "../src/reschedule.js";
import type { JobStatus, RelayJob } from "../src/types.js";

function job(id: string, status: JobStatus): RelayJob {
  const now = "2026-08-05T00:00:00.000Z";
  return {
    id,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status,
    resetAt: null,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    lastError: null,
    lastOutputTail: null,
  };
}

describe("canReschedule", () => {
  it("allows rescheduling queued and waiting jobs", () => {
    for (const status of RESCHEDULABLE_STATUSES) {
      expect(canReschedule(job("a", status)).ok).toBe(true);
    }
    // Explicitly the two pending states.
    expect(canReschedule(job("a", "queued")).ok).toBe(true);
    expect(canReschedule(job("a", "waiting_for_reset")).ok).toBe(true);
  });

  it("rejects an in-flight (resuming) job", () => {
    const result = canReschedule(job("a", "resuming"));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("resuming");
  });

  it("rejects terminal jobs with a reason", () => {
    for (const status of ["completed", "failed"] as JobStatus[]) {
      const result = canReschedule(job("a", status));
      expect(result.ok).toBe(false);
      expect(result.reason).toBeTruthy();
    }
  });

  it("steers a cancelled job toward retry", () => {
    const result = canReschedule(job("a", "cancelled"));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("retry");
  });
});

describe("resolveRescheduleTime", () => {
  const now = Date.parse("2026-08-05T12:00:00.000Z");

  it("resolves a bare duration relative to now", () => {
    expect(resolveRescheduleTime("30m", now)).toEqual({ resetAt: "2026-08-05T12:30:00.000Z" });
    expect(resolveRescheduleTime("2h", now)).toEqual({ resetAt: "2026-08-05T14:00:00.000Z" });
    expect(resolveRescheduleTime("1d", now)).toEqual({ resetAt: "2026-08-06T12:00:00.000Z" });
    expect(resolveRescheduleTime("90s", now)).toEqual({ resetAt: "2026-08-05T12:01:30.000Z" });
  });

  it("accepts a leading + on durations", () => {
    expect(resolveRescheduleTime("+45m", now)).toEqual({ resetAt: "2026-08-05T12:45:00.000Z" });
    expect(resolveRescheduleTime("+ 45m", now)).toEqual({ resetAt: "2026-08-05T12:45:00.000Z" });
  });

  it("treats 0s as due now (allowed)", () => {
    expect(resolveRescheduleTime("0s", now)).toEqual({ resetAt: "2026-08-05T12:00:00.000Z" });
  });

  it("resolves an absolute ISO timestamp, normalising to ISO", () => {
    expect(resolveRescheduleTime("2026-08-05T15:00:00Z", now)).toEqual({ resetAt: "2026-08-05T15:00:00.000Z" });
  });

  it("allows an absolute time in the past (operator's choice — becomes due now)", () => {
    expect(resolveRescheduleTime("2026-08-05T09:00:00Z", now)).toEqual({ resetAt: "2026-08-05T09:00:00.000Z" });
  });

  it("rejects empty input", () => {
    const result = resolveRescheduleTime("   ", now);
    expect(result).toHaveProperty("error");
    if ("error" in result) expect(result.error).toContain("no time");
  });

  it("rejects gibberish that is neither a duration nor a timestamp", () => {
    const result = resolveRescheduleTime("soon", now);
    expect(result).toHaveProperty("error");
    if ("error" in result) expect(result.error).toContain("could not parse");
  });

  it("does not treat a bare number as a duration (needs a unit)", () => {
    // "30" is not a valid duration; Date.parse also rejects it → error.
    const result = resolveRescheduleTime("30", now);
    expect(result).toHaveProperty("error");
  });
});
