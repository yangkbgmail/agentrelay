import { describe, expect, it } from "vitest";
import { canReschedule, RESCHEDULABLE_STATUSES, resolveResumeAt } from "../src/reschedule.js";
import type { JobStatus, RelayJob } from "../src/types.js";

function job(status: JobStatus): RelayJob {
  const now = "2026-07-13T00:00:00.000Z";
  return {
    id: "a",
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
  it("allows rescheduling pending jobs", () => {
    for (const status of RESCHEDULABLE_STATUSES) {
      expect(canReschedule(job(status)).ok).toBe(true);
    }
  });

  it("rejects an in-flight (resuming) job", () => {
    const result = canReschedule(job("resuming"));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("resuming");
  });

  it("rejects terminal jobs and points to retry", () => {
    for (const status of ["completed", "failed", "cancelled"] as JobStatus[]) {
      const result = canReschedule(job(status));
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("retry");
    }
  });

  it("only lists the pending statuses as reschedulable", () => {
    expect([...RESCHEDULABLE_STATUSES]).toEqual(["queued", "waiting_for_reset"]);
  });
});

describe("resolveResumeAt", () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0); // 2026-07-27T12:00:00Z

  it("reads a bare duration as relative to now", () => {
    const result = resolveResumeAt("2h", now);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.relative).toBe(true);
      expect(result.atMs).toBe(now + 2 * 60 * 60_000);
    }
  });

  it("accepts a leading + on a duration", () => {
    const result = resolveResumeAt("+30m", now);
    expect(result).toEqual({ atMs: now + 30 * 60_000, relative: true });
  });

  it("supports every duration unit", () => {
    expect(resolveResumeAt("500ms", now)).toEqual({ atMs: now + 500, relative: true });
    expect(resolveResumeAt("90s", now)).toEqual({ atMs: now + 90_000, relative: true });
    expect(resolveResumeAt("1d", now)).toEqual({ atMs: now + 24 * 60 * 60_000, relative: true });
  });

  it("reads an absolute ISO timestamp as non-relative", () => {
    const result = resolveResumeAt("2026-07-28T15:00:00Z", now);
    expect(result).toEqual({ atMs: Date.UTC(2026, 6, 28, 15, 0, 0), relative: false });
  });

  it("allows a resolved time in the past (job becomes due immediately)", () => {
    const result = resolveResumeAt("2020-01-01T00:00:00Z", now);
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(result.atMs).toBeLessThan(now);
  });

  it("rejects blank input", () => {
    expect(resolveResumeAt("   ", now)).toEqual({ error: "no resume time given" });
  });

  it("rejects a value that is neither a duration nor a timestamp", () => {
    const result = resolveResumeAt("soon-ish", now);
    expect("error" in result).toBe(true);
  });

  it("rejects a bare number with no unit (ambiguous)", () => {
    const result = resolveResumeAt("3600", now);
    expect("error" in result).toBe(true);
  });
});
