import { describe, expect, it } from "vitest";
import type { HeartbeatFacts } from "./doctor.js";
import { isHeartbeatAlive, resumeLoopStatus } from "./resumeLoop.js";

const alive: HeartbeatFacts = {
  present: true,
  mode: "daemon",
  pid: 4321,
  ageMs: 5_000,
  staleAfterMs: 60_000,
};

const stale: HeartbeatFacts = {
  present: true,
  mode: "daemon",
  pid: 4321,
  ageMs: 600_000,
  staleAfterMs: 60_000,
};

const absent: HeartbeatFacts = { present: false };

describe("isHeartbeatAlive", () => {
  it("is true only when present, aged, and within the staleness window", () => {
    expect(isHeartbeatAlive(alive)).toBe(true);
  });

  it("is false when the last tick is beyond the staleness window", () => {
    expect(isHeartbeatAlive(stale)).toBe(false);
  });

  it("treats age exactly at the threshold as still alive (inclusive)", () => {
    expect(isHeartbeatAlive({ present: true, ageMs: 60_000, staleAfterMs: 60_000 })).toBe(true);
  });

  it("is false when absent", () => {
    expect(isHeartbeatAlive(absent)).toBe(false);
  });

  it("is false when present but age/threshold are unknown", () => {
    expect(isHeartbeatAlive({ present: true })).toBe(false);
    expect(isHeartbeatAlive({ present: true, ageMs: 1000 })).toBe(false);
    expect(isHeartbeatAlive({ present: true, staleAfterMs: 60_000 })).toBe(false);
  });
});

describe("resumeLoopStatus", () => {
  it("reports alive with no concern regardless of waiting count", () => {
    const s = resumeLoopStatus(alive, 3);
    expect(s.state).toBe("alive");
    expect(s.concern).toBe(false);
    expect(s.waitingCount).toBe(3);
    expect(s.mode).toBe("daemon");
    expect(s.pid).toBe(4321);
    expect(s.ageMs).toBe(5_000);
    expect(s.staleAfterMs).toBe(60_000);
  });

  it("flags a concern when the loop is stale and jobs are waiting", () => {
    const s = resumeLoopStatus(stale, 2);
    expect(s.state).toBe("stale");
    expect(s.concern).toBe(true);
    expect(s.waitingCount).toBe(2);
  });

  it("does not flag a stale loop when nothing is waiting", () => {
    const s = resumeLoopStatus(stale, 0);
    expect(s.state).toBe("stale");
    expect(s.concern).toBe(false);
  });

  it("flags a concern when the loop is absent and jobs are waiting", () => {
    const s = resumeLoopStatus(absent, 1);
    expect(s.state).toBe("absent");
    expect(s.concern).toBe(true);
    expect(s.mode).toBeUndefined();
    expect(s.pid).toBeUndefined();
  });

  it("does not flag an absent loop when nothing is waiting", () => {
    const s = resumeLoopStatus(absent, 0);
    expect(s.state).toBe("absent");
    expect(s.concern).toBe(false);
  });

  it("sanitizes negative, fractional, and non-finite waiting counts", () => {
    expect(resumeLoopStatus(alive, -5).waitingCount).toBe(0);
    expect(resumeLoopStatus(stale, -5).concern).toBe(false);
    expect(resumeLoopStatus(stale, 2.9).waitingCount).toBe(2);
    expect(resumeLoopStatus(stale, Number.NaN).waitingCount).toBe(0);
    expect(resumeLoopStatus(stale, Number.POSITIVE_INFINITY).waitingCount).toBe(0);
  });
});
