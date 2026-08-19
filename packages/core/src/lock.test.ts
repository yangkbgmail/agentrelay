import { describe, expect, it } from "vitest";
import type { DaemonHeartbeat } from "./heartbeat.js";
import { heartbeatStaleAfterMs } from "./heartbeat.js";
import { evaluateDaemonLock } from "./lock.js";

const NOW = Date.UTC(2026, 7, 19, 12, 0, 0);

function daemonBeat(overrides: Partial<DaemonHeartbeat> = {}): DaemonHeartbeat {
  return {
    pid: 4242,
    mode: "daemon",
    startedAt: new Date(NOW - 60_000).toISOString(),
    lastTickAt: new Date(NOW - 5_000).toISOString(),
    pollIntervalMs: 30_000,
    ...overrides,
  };
}

describe("evaluateDaemonLock", () => {
  it("starts when there is no heartbeat at all", () => {
    const decision = evaluateDaemonLock(null, { nowMs: NOW, selfPid: 1, pidAlive: false });
    expect(decision.action).toBe("start");
    expect(decision.holder).toBeUndefined();
    expect(decision.reason).toMatch(/no resume loop/i);
  });

  it("refuses when a fresh daemon heartbeat's pid is alive and not ours", () => {
    const decision = evaluateDaemonLock(daemonBeat(), { nowMs: NOW, selfPid: 999, pidAlive: true });
    expect(decision.action).toBe("refuse");
    expect(decision.holder?.pid).toBe(4242);
    expect(decision.reason).toMatch(/already running/i);
    expect(decision.reason).toContain("4242");
  });

  it("takes over a stale daemon heartbeat regardless of pid liveness", () => {
    // Last tick well beyond the staleness window (30s poll → 90s stale window).
    const beat = daemonBeat({ lastTickAt: new Date(NOW - 10 * 60_000).toISOString() });
    const decision = evaluateDaemonLock(beat, { nowMs: NOW, selfPid: 999, pidAlive: true });
    expect(decision.action).toBe("start");
    expect(decision.reason).toMatch(/stale/i);
    expect(decision.holder?.pid).toBe(4242);
  });

  it("takes over a fresh heartbeat whose pid is dead", () => {
    const decision = evaluateDaemonLock(daemonBeat(), { nowMs: NOW, selfPid: 999, pidAlive: false });
    expect(decision.action).toBe("start");
    expect(decision.reason).toMatch(/no longer running/i);
    expect(decision.holder?.pid).toBe(4242);
  });

  it("starts when the heartbeat belongs to this very process", () => {
    const decision = evaluateDaemonLock(daemonBeat({ pid: 777 }), { nowMs: NOW, selfPid: 777, pidAlive: true });
    expect(decision.action).toBe("start");
    expect(decision.reason).toMatch(/this process/i);
  });

  it("never lets a tick heartbeat hold the lock, even fresh with a live pid", () => {
    const beat = daemonBeat({ mode: "tick", pollIntervalMs: 0, lastTickAt: new Date(NOW - 1_000).toISOString() });
    const decision = evaluateDaemonLock(beat, { nowMs: NOW, selfPid: 999, pidAlive: true });
    expect(decision.action).toBe("start");
    expect(decision.reason).toMatch(/one-shot tick/i);
    expect(decision.holder?.mode).toBe("tick");
  });

  it("treats an unparseable lastTickAt as stale (takes over)", () => {
    const decision = evaluateDaemonLock(daemonBeat({ lastTickAt: "not-a-date" }), {
      nowMs: NOW,
      selfPid: 999,
      pidAlive: true,
    });
    expect(decision.action).toBe("start");
    expect(decision.reason).toMatch(/stale/i);
    expect(decision.holder?.ageMs).toBeUndefined();
  });

  it("populates holder.staleAfterMs from the heartbeat's mode/interval by default", () => {
    const decision = evaluateDaemonLock(daemonBeat(), { nowMs: NOW, selfPid: 999, pidAlive: true });
    expect(decision.holder?.staleAfterMs).toBe(heartbeatStaleAfterMs("daemon", 30_000));
  });

  it("respects a staleAfterMs override for the freshness cut", () => {
    // Age is ~5s; a 1s override makes even this recent heartbeat count as stale.
    const decision = evaluateDaemonLock(daemonBeat(), {
      nowMs: NOW,
      selfPid: 999,
      pidAlive: true,
      staleAfterMs: 1_000,
    });
    expect(decision.action).toBe("start");
    expect(decision.reason).toMatch(/stale/i);
    expect(decision.holder?.staleAfterMs).toBe(1_000);
  });

  it("refuses right at the freshness boundary (age === staleAfterMs)", () => {
    const staleAfterMs = heartbeatStaleAfterMs("daemon", 30_000);
    const beat = daemonBeat({ lastTickAt: new Date(NOW - staleAfterMs).toISOString() });
    const decision = evaluateDaemonLock(beat, { nowMs: NOW, selfPid: 999, pidAlive: true });
    expect(decision.action).toBe("refuse");
  });
});
