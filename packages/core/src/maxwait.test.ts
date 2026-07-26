import { describe, expect, it } from "vitest";
import { exceedsMaxWait, maxWaitMsFromEnv } from "./maxwait.js";

describe("maxWaitMsFromEnv", () => {
  it("returns null when the var is unset", () => {
    expect(maxWaitMsFromEnv({})).toBeNull();
  });

  it("returns null for a blank / whitespace-only value", () => {
    expect(maxWaitMsFromEnv({ AGENTRELAY_MAX_WAIT: "" })).toBeNull();
    expect(maxWaitMsFromEnv({ AGENTRELAY_MAX_WAIT: "   " })).toBeNull();
  });

  it("parses common duration forms into ms", () => {
    expect(maxWaitMsFromEnv({ AGENTRELAY_MAX_WAIT: "6h" })).toBe(6 * 60 * 60 * 1000);
    expect(maxWaitMsFromEnv({ AGENTRELAY_MAX_WAIT: "2d" })).toBe(2 * 24 * 60 * 60 * 1000);
    expect(maxWaitMsFromEnv({ AGENTRELAY_MAX_WAIT: "30m" })).toBe(30 * 60 * 1000);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(maxWaitMsFromEnv({ AGENTRELAY_MAX_WAIT: "  45m  " })).toBe(45 * 60 * 1000);
  });

  it("returns null (lenient, no cap) for an unparseable value", () => {
    expect(maxWaitMsFromEnv({ AGENTRELAY_MAX_WAIT: "soon" })).toBeNull();
    expect(maxWaitMsFromEnv({ AGENTRELAY_MAX_WAIT: "6 hours" })).toBeNull();
  });

  it("returns null for a non-positive duration", () => {
    expect(maxWaitMsFromEnv({ AGENTRELAY_MAX_WAIT: "0s" })).toBeNull();
  });
});

describe("exceedsMaxWait", () => {
  const now = Date.parse("2026-07-13T00:00:00.000Z");
  const in3h = "2026-07-13T03:00:00.000Z";
  const in12h = "2026-07-13T12:00:00.000Z";

  it("never exceeds when there is no cap (null / undefined)", () => {
    expect(exceedsMaxWait(in12h, now, null)).toBe(false);
    expect(exceedsMaxWait(in12h, now, undefined)).toBe(false);
  });

  it("is false when the reset is within the cap", () => {
    expect(exceedsMaxWait(in3h, now, 6 * 60 * 60 * 1000)).toBe(false);
  });

  it("is true when the reset is beyond the cap", () => {
    expect(exceedsMaxWait(in12h, now, 6 * 60 * 60 * 1000)).toBe(true);
  });

  it("treats a reset exactly at the cap as within it (not exceeding)", () => {
    expect(exceedsMaxWait(in3h, now, 3 * 60 * 60 * 1000)).toBe(false);
  });

  it("treats an already-past reset as within any cap", () => {
    expect(exceedsMaxWait("2026-07-12T20:00:00.000Z", now, 1 * 60 * 60 * 1000)).toBe(false);
  });

  it("treats an unparseable resetAt as exceeding (defensive)", () => {
    expect(exceedsMaxWait("not-a-date", now, 6 * 60 * 60 * 1000)).toBe(true);
  });

  it("still returns false for an unparseable resetAt when there is no cap", () => {
    expect(exceedsMaxWait("not-a-date", now, null)).toBe(false);
  });
});
