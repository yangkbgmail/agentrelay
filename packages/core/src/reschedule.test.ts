import { describe, expect, it } from "vitest";
import { resolveResumeTime } from "./reschedule.js";

const NOW = Date.parse("2026-08-10T12:00:00.000Z");

describe("resolveResumeTime", () => {
  it('treats "now" as the current instant', () => {
    expect(resolveResumeTime("now", NOW)).toEqual({ atMs: NOW });
    expect(resolveResumeTime("NOW", NOW)).toEqual({ atMs: NOW });
  });

  it('treats "0" as the current instant', () => {
    expect(resolveResumeTime("0", NOW)).toEqual({ atMs: NOW });
  });

  it("adds a bare duration to now", () => {
    expect(resolveResumeTime("2h", NOW)).toEqual({ atMs: NOW + 2 * 3_600_000 });
    expect(resolveResumeTime("30m", NOW)).toEqual({ atMs: NOW + 30 * 60_000 });
    expect(resolveResumeTime("90s", NOW)).toEqual({ atMs: NOW + 90_000 });
    expect(resolveResumeTime("500ms", NOW)).toEqual({ atMs: NOW + 500 });
    expect(resolveResumeTime("1d", NOW)).toEqual({ atMs: NOW + 86_400_000 });
  });

  it("accepts a leading + on a duration", () => {
    expect(resolveResumeTime("+2h", NOW)).toEqual({ atMs: NOW + 2 * 3_600_000 });
    expect(resolveResumeTime("+ 45m", NOW)).toEqual({ atMs: NOW + 45 * 60_000 });
  });

  it("parses an absolute ISO timestamp regardless of now", () => {
    const iso = "2026-08-11T09:30:00.000Z";
    expect(resolveResumeTime(iso, NOW)).toEqual({ atMs: Date.parse(iso) });
  });

  it("allows a past absolute time (means due now to the scheduler)", () => {
    const past = "2026-08-10T06:00:00.000Z";
    expect(resolveResumeTime(past, NOW)).toEqual({ atMs: Date.parse(past) });
  });

  it("trims surrounding whitespace", () => {
    expect(resolveResumeTime("  2h  ", NOW)).toEqual({ atMs: NOW + 2 * 3_600_000 });
  });

  it("errors on empty input", () => {
    expect(resolveResumeTime("", NOW).error).toMatch(/no time/i);
    expect(resolveResumeTime("   ", NOW).error).toMatch(/no time/i);
  });

  it("errors on a unitless number (guards Date.parse reading it as a year)", () => {
    // Date.parse("500") is year 500, not 500 of anything — reject the bare
    // number and advise a unit instead of silently scheduling in the far past.
    const result = resolveResumeTime("500", NOW);
    expect(result.atMs).toBeUndefined();
    expect(result.error).toMatch(/ambiguous/i);
  });

  it("errors on gibberish", () => {
    const result = resolveResumeTime("whenever", NOW);
    expect(result.atMs).toBeUndefined();
    expect(result.error).toMatch(/could not parse/i);
  });

  it("rejects a negative duration", () => {
    expect(resolveResumeTime("-2h", NOW).error).toMatch(/could not parse/i);
  });
});
