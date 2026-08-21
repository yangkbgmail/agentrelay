import { describe, expect, it } from "vitest";
import { resolveScheduleTime } from "./schedule.js";

const NOW = new Date("2026-08-21T12:00:00.000Z");

describe("resolveScheduleTime", () => {
  it("resolves --in relative durations from now", () => {
    const r = resolveScheduleTime({ in: "2h" }, NOW);
    expect(r.resetAt).toBe("2026-08-21T14:00:00.000Z");
    expect(r.resetMs).toBe(NOW.getTime() + 2 * 60 * 60_000);
    expect(r.immediate).toBe(false);
  });

  it("supports compact duration units for --in", () => {
    expect(resolveScheduleTime({ in: "30m" }, NOW).resetAt).toBe("2026-08-21T12:30:00.000Z");
    expect(resolveScheduleTime({ in: "1d" }, NOW).resetAt).toBe("2026-08-22T12:00:00.000Z");
    expect(resolveScheduleTime({ in: "90s" }, NOW).resetAt).toBe("2026-08-21T12:01:30.000Z");
  });

  it("treats --in 0s as immediate (already due)", () => {
    const r = resolveScheduleTime({ in: "0s" }, NOW);
    expect(r.resetAt).toBe(NOW.toISOString());
    expect(r.immediate).toBe(true);
  });

  it("resolves --at ISO 8601 timestamps", () => {
    const r = resolveScheduleTime({ at: "2026-08-21T15:30:00Z" }, NOW);
    expect(r.resetAt).toBe("2026-08-21T15:30:00.000Z");
    expect(r.immediate).toBe(false);
  });

  it("marks a past --at time as immediate rather than an error", () => {
    const r = resolveScheduleTime({ at: "2026-08-21T11:00:00Z" }, NOW);
    expect(r.immediate).toBe(true);
  });

  it("resolves --at unix epoch seconds (10 digits)", () => {
    const secs = Math.floor(new Date("2026-08-21T18:00:00Z").getTime() / 1000);
    const r = resolveScheduleTime({ at: String(secs) }, NOW);
    expect(r.resetAt).toBe("2026-08-21T18:00:00.000Z");
  });

  it("resolves --at unix epoch milliseconds (13 digits)", () => {
    const ms = new Date("2026-08-21T18:00:00Z").getTime();
    const r = resolveScheduleTime({ at: String(ms) }, NOW);
    expect(r.resetAt).toBe("2026-08-21T18:00:00.000Z");
  });

  it("rejects passing both --in and --at", () => {
    expect(() => resolveScheduleTime({ in: "2h", at: "2026-08-21T15:00:00Z" }, NOW)).toThrow(
      /only one of --in or --at/
    );
  });

  it("rejects passing neither --in nor --at", () => {
    expect(() => resolveScheduleTime({}, NOW)).toThrow(/Specify when to run/);
    expect(() => resolveScheduleTime({ in: "  ", at: "" }, NOW)).toThrow(/Specify when to run/);
  });

  it("rejects an unparseable --in duration", () => {
    expect(() => resolveScheduleTime({ in: "soon" }, NOW)).toThrow(/Invalid --in duration/);
  });

  it("rejects an unparseable --at time", () => {
    expect(() => resolveScheduleTime({ at: "3pm tomorrow" }, NOW)).toThrow(/Invalid --at time/);
    expect(() => resolveScheduleTime({ at: "not-a-date" }, NOW)).toThrow(/Invalid --at time/);
  });
});
