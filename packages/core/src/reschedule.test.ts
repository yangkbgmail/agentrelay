import { describe, expect, it } from "vitest";
import { canReschedule, isRescheduleTimeError, parseRescheduleWhen, RESCHEDULABLE_STATUSES } from "./reschedule.js";
import type { JobStatus, RelayJob } from "./types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "waiting_for_reset",
    resetAt: "2026-08-02T09:00:00.000Z",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    attempts: 2,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-08-02T10:00:00.000Z");

describe("canReschedule", () => {
  it("accepts queued and waiting_for_reset jobs", () => {
    expect(canReschedule(job({ status: "queued" }))).toEqual({ ok: true });
    expect(canReschedule(job({ status: "waiting_for_reset" }))).toEqual({ ok: true });
  });

  it("rejects a resuming job with a race-avoidance reason", () => {
    const result = canReschedule(job({ status: "resuming" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("resuming");
  });

  it.each<JobStatus>(["completed", "failed", "cancelled"])("rejects the terminal %s state", (status) => {
    const result = canReschedule(job({ status }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(status);
    expect(result.reason).toContain("retry");
  });

  it("keeps RESCHEDULABLE_STATUSES to the two pending states", () => {
    expect([...RESCHEDULABLE_STATUSES]).toEqual(["queued", "waiting_for_reset"]);
  });
});

describe("parseRescheduleWhen", () => {
  it('parses "now" (any case) to the current instant', () => {
    const result = parseRescheduleWhen("NoW", NOW);
    expect(isRescheduleTimeError(result)).toBe(false);
    if (!isRescheduleTimeError(result)) {
      expect(result.kind).toBe("now");
      expect(Date.parse(result.at)).toBe(NOW);
    }
  });

  it("parses a duration as relative to now", () => {
    const result = parseRescheduleWhen("2h", NOW);
    expect(isRescheduleTimeError(result)).toBe(false);
    if (!isRescheduleTimeError(result)) {
      expect(result.kind).toBe("duration");
      expect(Date.parse(result.at)).toBe(NOW + 2 * 60 * 60 * 1000);
    }
  });

  it("supports sub-hour and sub-second duration units", () => {
    const m = parseRescheduleWhen("90m", NOW);
    const s = parseRescheduleWhen("500ms", NOW);
    if (!isRescheduleTimeError(m)) expect(Date.parse(m.at)).toBe(NOW + 90 * 60 * 1000);
    if (!isRescheduleTimeError(s)) expect(Date.parse(s.at)).toBe(NOW + 500);
  });

  it("parses an ISO 8601 timestamp as an absolute time", () => {
    const result = parseRescheduleWhen("2026-08-02T18:00:00.000Z", NOW);
    expect(isRescheduleTimeError(result)).toBe(false);
    if (!isRescheduleTimeError(result)) {
      expect(result.kind).toBe("absolute");
      expect(result.at).toBe("2026-08-02T18:00:00.000Z");
    }
  });

  it("allows a past absolute time (means due immediately)", () => {
    const result = parseRescheduleWhen("2026-08-02T09:00:00.000Z", NOW);
    expect(isRescheduleTimeError(result)).toBe(false);
    if (!isRescheduleTimeError(result)) {
      expect(Date.parse(result.at)).toBeLessThan(NOW);
    }
  });

  it("trims surrounding whitespace", () => {
    const result = parseRescheduleWhen("  1d  ", NOW);
    if (!isRescheduleTimeError(result)) {
      expect(Date.parse(result.at)).toBe(NOW + 24 * 60 * 60 * 1000);
    }
  });

  it("rejects an empty string", () => {
    const result = parseRescheduleWhen("   ", NOW);
    expect(isRescheduleTimeError(result)).toBe(true);
    if (isRescheduleTimeError(result)) expect(result.error).toContain("no time");
  });

  it("rejects gibberish with a helpful message", () => {
    const result = parseRescheduleWhen("later maybe", NOW);
    expect(isRescheduleTimeError(result)).toBe(true);
    if (isRescheduleTimeError(result)) {
      expect(result.error).toContain("could not understand");
      expect(result.error).toContain("2h");
    }
  });

  it("rejects a negative duration (no unit-only or negative parse)", () => {
    expect(isRescheduleTimeError(parseRescheduleWhen("-2h", NOW))).toBe(true);
  });
});
