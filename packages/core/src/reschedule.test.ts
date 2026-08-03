import { describe, expect, it } from "vitest";
import { canReschedule, RESCHEDULABLE_STATUSES } from "./control.js";
import { resolveRescheduleTime } from "./reschedule.js";
import type { JobStatus, RelayJob } from "./types.js";

const NOW = new Date("2026-08-03T12:00:00.000Z");

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "abcd1234-0000-0000-0000-000000000000",
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "waiting_for_reset",
    resetAt: "2026-08-03T15:00:00.000Z",
    createdAt: "2026-08-03T10:00:00.000Z",
    updatedAt: "2026-08-03T10:00:00.000Z",
    attempts: 2,
    lastError: null,
    lastOutputTail: null,
    lastRateLimit: null,
    ...overrides,
  };
}

describe("resolveRescheduleTime", () => {
  it("resolves a relative duration to now + that long", () => {
    expect(resolveRescheduleTime("30m", NOW)).toEqual({ at: "2026-08-03T12:30:00.000Z" });
    expect(resolveRescheduleTime("2h", NOW)).toEqual({ at: "2026-08-03T14:00:00.000Z" });
    expect(resolveRescheduleTime("1d", NOW)).toEqual({ at: "2026-08-04T12:00:00.000Z" });
    expect(resolveRescheduleTime("90s", NOW)).toEqual({ at: "2026-08-03T12:01:30.000Z" });
  });

  it('treats "now" (any case) and "0" as immediate', () => {
    expect(resolveRescheduleTime("now", NOW)).toEqual({ at: NOW.toISOString() });
    expect(resolveRescheduleTime("NOW", NOW)).toEqual({ at: NOW.toISOString() });
    expect(resolveRescheduleTime("0", NOW)).toEqual({ at: NOW.toISOString() });
  });

  it("accepts an absolute ISO timestamp and normalizes it", () => {
    expect(resolveRescheduleTime("2026-08-04T05:00:00Z", NOW)).toEqual({ at: "2026-08-04T05:00:00.000Z" });
  });

  it("allows an absolute time in the past (means due immediately)", () => {
    expect(resolveRescheduleTime("2020-01-01T00:00:00Z", NOW)).toEqual({ at: "2020-01-01T00:00:00.000Z" });
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(resolveRescheduleTime("  15m  ", NOW)).toEqual({ at: "2026-08-03T12:15:00.000Z" });
  });

  it("rejects empty input", () => {
    expect(resolveRescheduleTime("", NOW).error).toMatch(/no time given/);
    expect(resolveRescheduleTime("   ", NOW).error).toMatch(/no time given/);
  });

  it("rejects an unintelligible time with guidance", () => {
    const result = resolveRescheduleTime("whenever", NOW);
    expect(result.at).toBeUndefined();
    expect(result.error).toMatch(/could not understand/);
  });

  it("rejects a bare number with no unit", () => {
    expect(resolveRescheduleTime("30", NOW).error).toMatch(/could not understand/);
  });
});

describe("canReschedule", () => {
  it("accepts pending jobs (queued / waiting_for_reset)", () => {
    expect(canReschedule(job({ status: "queued" })).ok).toBe(true);
    expect(canReschedule(job({ status: "waiting_for_reset" })).ok).toBe(true);
  });

  it("rejects an in-flight resuming job", () => {
    const result = canReschedule(job({ status: "resuming" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/currently resuming/);
  });

  it("rejects terminal jobs and points at retry", () => {
    for (const status of ["completed", "failed", "cancelled"] as JobStatus[]) {
      const result = canReschedule(job({ status }));
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/retry/);
    }
  });

  it("only lists the pending statuses as reschedulable", () => {
    expect([...RESCHEDULABLE_STATUSES]).toEqual(["queued", "waiting_for_reset"]);
  });
});
