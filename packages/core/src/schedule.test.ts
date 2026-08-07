import { describe, expect, it } from "vitest";
import { isScheduleTimeError, resolveScheduledResetAt } from "./schedule.js";

const NOW = Date.parse("2026-08-07T12:00:00.000Z");

describe("resolveScheduledResetAt", () => {
  it("resolves a relative --in duration to now + duration", () => {
    const result = resolveScheduledResetAt({ in: "5h", now: NOW });
    expect(isScheduleTimeError(result)).toBe(false);
    if (isScheduleTimeError(result)) return;
    expect(result.resetAtMs).toBe(NOW + 5 * 60 * 60 * 1000);
    expect(result.resetAt).toBe("2026-08-07T17:00:00.000Z");
  });

  it("supports minute and second durations", () => {
    const mins = resolveScheduledResetAt({ in: "30m", now: NOW });
    const secs = resolveScheduledResetAt({ in: "90s", now: NOW });
    if (isScheduleTimeError(mins) || isScheduleTimeError(secs)) throw new Error("unexpected error");
    expect(mins.resetAtMs).toBe(NOW + 30 * 60 * 1000);
    expect(secs.resetAtMs).toBe(NOW + 90 * 1000);
  });

  it("resolves an absolute --at ISO instant", () => {
    const result = resolveScheduledResetAt({ at: "2026-08-08T02:00:00Z", now: NOW });
    if (isScheduleTimeError(result)) throw new Error("unexpected error");
    expect(result.resetAt).toBe("2026-08-08T02:00:00.000Z");
    expect(result.resetAtMs).toBe(Date.parse("2026-08-08T02:00:00Z"));
  });

  it("allows an --at time in the past (immediately due)", () => {
    const result = resolveScheduledResetAt({ at: "2020-01-01T00:00:00Z", now: NOW });
    if (isScheduleTimeError(result)) throw new Error("unexpected error");
    expect(result.resetAtMs).toBeLessThan(NOW);
  });

  it("rejects supplying both --at and --in", () => {
    const result = resolveScheduledResetAt({ at: "2026-08-08T02:00:00Z", in: "5h", now: NOW });
    expect(isScheduleTimeError(result)).toBe(true);
    if (!isScheduleTimeError(result)) return;
    expect(result.error).toMatch(/not both/);
  });

  it("rejects supplying neither --at nor --in", () => {
    const result = resolveScheduledResetAt({ now: NOW });
    expect(isScheduleTimeError(result)).toBe(true);
  });

  it("treats blank strings as absent", () => {
    const result = resolveScheduledResetAt({ at: "  ", in: "", now: NOW });
    expect(isScheduleTimeError(result)).toBe(true);
    if (!isScheduleTimeError(result)) return;
    expect(result.error).toMatch(/--at <time> or --in <duration>/);
  });

  it("rejects an unparseable --in duration", () => {
    const result = resolveScheduledResetAt({ in: "soon", now: NOW });
    expect(isScheduleTimeError(result)).toBe(true);
    if (!isScheduleTimeError(result)) return;
    expect(result.error).toMatch(/Invalid --in/);
  });

  it("rejects a zero/negative --in duration", () => {
    const result = resolveScheduledResetAt({ in: "0s", now: NOW });
    expect(isScheduleTimeError(result)).toBe(true);
    if (!isScheduleTimeError(result)) return;
    expect(result.error).toMatch(/positive duration/);
  });

  it("rejects an unparseable --at time", () => {
    const result = resolveScheduledResetAt({ at: "not-a-date", now: NOW });
    expect(isScheduleTimeError(result)).toBe(true);
    if (!isScheduleTimeError(result)) return;
    expect(result.error).toMatch(/Invalid --at/);
  });
});
