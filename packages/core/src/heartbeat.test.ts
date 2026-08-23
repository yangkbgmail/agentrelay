import { describe, expect, it } from "vitest";
import {
  type DaemonHeartbeat,
  evaluateDaemonConflict,
  HEARTBEAT_MIN_STALE_AFTER_MS,
  heartbeatStaleAfterMs,
} from "./heartbeat.js";

/** Build a daemon-mode heartbeat whose lastTick is `ageMs` before `now`. */
function daemonBeat(overrides: Partial<DaemonHeartbeat> = {}): DaemonHeartbeat {
  return {
    pid: 4242,
    mode: "daemon",
    startedAt: "2026-08-23T00:00:00.000Z",
    lastTickAt: "2026-08-23T00:00:00.000Z",
    pollIntervalMs: 30_000,
    ...overrides,
  };
}

const now = Date.parse("2026-08-23T00:00:00.000Z");

describe("evaluateDaemonConflict", () => {
  it("reports not running when there is no heartbeat", () => {
    expect(evaluateDaemonConflict(null, { nowMs: now, pidAlive: false })).toEqual({ running: false });
    // pidAlive is irrelevant with no heartbeat.
    expect(evaluateDaemonConflict(null, { nowMs: now, pidAlive: true })).toEqual({ running: false });
  });

  it("reports running for a fresh daemon beat whose pid is alive", () => {
    const beat = daemonBeat({ lastTickAt: new Date(now - 5_000).toISOString() });
    const verdict = evaluateDaemonConflict(beat, { nowMs: now, pidAlive: true });
    expect(verdict.running).toBe(true);
    if (verdict.running) {
      expect(verdict.pid).toBe(4242);
      expect(verdict.ageMs).toBe(5_000);
      expect(verdict.lastTickAt).toBe(beat.lastTickAt);
    }
  });

  it("does not conflict when the recorded pid is dead (ghost file)", () => {
    const beat = daemonBeat({ lastTickAt: new Date(now - 5_000).toISOString() });
    expect(evaluateDaemonConflict(beat, { nowMs: now, pidAlive: false })).toEqual({ running: false });
  });

  it("ignores a one-shot tick heartbeat even if its pid is alive", () => {
    const beat = daemonBeat({ mode: "tick", pollIntervalMs: 0, lastTickAt: new Date(now).toISOString() });
    expect(evaluateDaemonConflict(beat, { nowMs: now, pidAlive: true })).toEqual({ running: false });
  });

  it("does not conflict when a live pid's beat is stale (wedged/reused pid)", () => {
    const staleAfter = heartbeatStaleAfterMs("daemon", 30_000);
    const beat = daemonBeat({ lastTickAt: new Date(now - staleAfter - 1).toISOString() });
    expect(evaluateDaemonConflict(beat, { nowMs: now, pidAlive: true })).toEqual({ running: false });
  });

  it("conflicts right up to the staleness boundary", () => {
    const staleAfter = heartbeatStaleAfterMs("daemon", 30_000);
    const beat = daemonBeat({ lastTickAt: new Date(now - staleAfter).toISOString() });
    expect(evaluateDaemonConflict(beat, { nowMs: now, pidAlive: true }).running).toBe(true);
  });

  it("uses the interval floor so a fast-polling daemon isn't judged stale early", () => {
    // 1s poll → staleness floored at HEARTBEAT_MIN_STALE_AFTER_MS, not 3s.
    const beat = daemonBeat({ pollIntervalMs: 1_000, lastTickAt: new Date(now - 30_000).toISOString() });
    expect(HEARTBEAT_MIN_STALE_AFTER_MS).toBeGreaterThan(30_000);
    expect(evaluateDaemonConflict(beat, { nowMs: now, pidAlive: true }).running).toBe(true);
  });

  it("treats a clock-skewed future beat as fresh (running)", () => {
    const beat = daemonBeat({ lastTickAt: new Date(now + 10_000).toISOString() });
    expect(evaluateDaemonConflict(beat, { nowMs: now, pidAlive: true }).running).toBe(true);
  });

  it("does not conflict on an unparseable lastTickAt", () => {
    const beat = daemonBeat({ lastTickAt: "not-a-date" });
    expect(evaluateDaemonConflict(beat, { nowMs: now, pidAlive: true })).toEqual({ running: false });
  });
});
