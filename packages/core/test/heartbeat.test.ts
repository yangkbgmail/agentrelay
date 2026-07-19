import { describe, expect, it } from "vitest";
import {
  DAEMON_HEARTBEAT_FILENAME,
  type DaemonHeartbeat,
  daemonHeartbeatPath,
  evaluateDaemonConflict,
  HEARTBEAT_MIN_STALE_AFTER_MS,
  HEARTBEAT_STALE_FACTOR,
  HEARTBEAT_TICK_STALE_AFTER_MS,
  heartbeatStaleAfterMs,
  parseDaemonHeartbeat,
  serializeDaemonHeartbeat,
} from "../src/heartbeat.js";

const sample: DaemonHeartbeat = {
  pid: 1234,
  mode: "daemon",
  startedAt: "2026-07-19T00:00:00.000Z",
  lastTickAt: "2026-07-19T00:00:30.000Z",
  pollIntervalMs: 30_000,
};

describe("daemonHeartbeatPath", () => {
  it("puts the heartbeat next to the store file", () => {
    expect(daemonHeartbeatPath("/home/u/.agentrelay/jobs.json")).toBe(
      `/home/u/.agentrelay/${DAEMON_HEARTBEAT_FILENAME}`
    );
  });
});

describe("serialize/parse round-trip", () => {
  it("round-trips a heartbeat losslessly", () => {
    expect(parseDaemonHeartbeat(serializeDaemonHeartbeat(sample))).toEqual(sample);
  });

  it("round-trips a one-shot tick heartbeat", () => {
    const tick: DaemonHeartbeat = { ...sample, mode: "tick", pollIntervalMs: 0 };
    expect(parseDaemonHeartbeat(serializeDaemonHeartbeat(tick))).toEqual(tick);
  });
});

describe("parseDaemonHeartbeat", () => {
  it("returns null for non-JSON", () => {
    expect(parseDaemonHeartbeat("{ not json")).toBeNull();
  });

  it("returns null for a JSON array or primitive", () => {
    expect(parseDaemonHeartbeat("[]")).toBeNull();
    expect(parseDaemonHeartbeat("42")).toBeNull();
    expect(parseDaemonHeartbeat("null")).toBeNull();
  });

  it("returns null when required fields are missing or mistyped", () => {
    expect(
      parseDaemonHeartbeat(JSON.stringify({ pid: "x", startedAt: "a", lastTickAt: "b", pollIntervalMs: 0 }))
    ).toBeNull();
    expect(parseDaemonHeartbeat(JSON.stringify({ pid: 1, lastTickAt: "b", pollIntervalMs: 0 }))).toBeNull();
    expect(parseDaemonHeartbeat(JSON.stringify({ pid: 1, startedAt: "a", lastTickAt: "b" }))).toBeNull();
  });

  it("returns null for a non-finite pid or pollIntervalMs", () => {
    expect(parseDaemonHeartbeat('{"pid":null,"startedAt":"a","lastTickAt":"b","pollIntervalMs":0}')).toBeNull();
  });

  it("infers mode=daemon from a positive pollIntervalMs when mode is absent", () => {
    const parsed = parseDaemonHeartbeat(
      JSON.stringify({ pid: 1, startedAt: "a", lastTickAt: "b", pollIntervalMs: 30_000 })
    );
    expect(parsed?.mode).toBe("daemon");
  });

  it("infers mode=tick from a zero pollIntervalMs when mode is absent/unknown", () => {
    const parsed = parseDaemonHeartbeat(
      JSON.stringify({ pid: 1, mode: "bogus", startedAt: "a", lastTickAt: "b", pollIntervalMs: 0 })
    );
    expect(parsed?.mode).toBe("tick");
  });
});

describe("heartbeatStaleAfterMs", () => {
  it("uses pollInterval * factor for a daemon, above the floor", () => {
    expect(heartbeatStaleAfterMs("daemon", 60_000)).toBe(60_000 * HEARTBEAT_STALE_FACTOR);
  });

  it("clamps a fast daemon poll up to the floor", () => {
    // 5s poll * 3 = 15s, below the 60s floor
    expect(heartbeatStaleAfterMs("daemon", 5_000)).toBe(HEARTBEAT_MIN_STALE_AFTER_MS);
  });

  it("uses the generous fixed window for a one-shot tick", () => {
    expect(heartbeatStaleAfterMs("tick", 0)).toBe(HEARTBEAT_TICK_STALE_AFTER_MS);
  });

  it("treats a non-positive daemon poll as tick-style", () => {
    expect(heartbeatStaleAfterMs("daemon", 0)).toBe(HEARTBEAT_TICK_STALE_AFTER_MS);
  });
});

describe("evaluateDaemonConflict", () => {
  // lastTickAt is 00:00:30; staleAfter for a 30s daemon poll is 90s (>60s floor).
  const lastTickMs = Date.parse(sample.lastTickAt);
  const opts = (nowMs: number, selfPid = 9999) => ({ nowMs, selfPid });

  it("reports no conflict when there is no heartbeat", () => {
    expect(evaluateDaemonConflict(null, opts(lastTickMs))).toEqual({ conflict: false, reason: "absent" });
  });

  it("never blocks on a one-shot tick heartbeat", () => {
    const tick: DaemonHeartbeat = { ...sample, mode: "tick", pollIntervalMs: 0 };
    const result = evaluateDaemonConflict(tick, opts(lastTickMs));
    expect(result).toEqual({ conflict: false, reason: "tick", pid: 1234 });
  });

  it("never blocks on its own pid", () => {
    const result = evaluateDaemonConflict(sample, opts(lastTickMs, sample.pid));
    expect(result).toEqual({ conflict: false, reason: "self", pid: 1234 });
  });

  it("conflicts on a fresh daemon heartbeat from another pid", () => {
    // 30s after the last tick — well within the 90s stale window.
    const result = evaluateDaemonConflict(sample, opts(lastTickMs + 30_000));
    expect(result.conflict).toBe(true);
    expect(result.reason).toBe("live");
    expect(result.pid).toBe(1234);
    expect(result.ageMs).toBe(30_000);
    expect(result.staleAfterMs).toBe(90_000);
  });

  it("treats the exact stale boundary as still live", () => {
    const result = evaluateDaemonConflict(sample, opts(lastTickMs + 90_000));
    expect(result.conflict).toBe(true);
    expect(result.reason).toBe("live");
  });

  it("does not conflict once the daemon heartbeat is stale", () => {
    const result = evaluateDaemonConflict(sample, opts(lastTickMs + 90_001));
    expect(result.conflict).toBe(false);
    expect(result.reason).toBe("stale");
    expect(result.pid).toBe(1234);
  });

  it("clamps a negative age (future lastTick / clock skew) to 0 and treats it as live", () => {
    const result = evaluateDaemonConflict(sample, opts(lastTickMs - 5_000));
    expect(result.conflict).toBe(true);
    expect(result.ageMs).toBe(0);
  });

  it("treats an unparseable lastTickAt as stale, not live", () => {
    const bad: DaemonHeartbeat = { ...sample, lastTickAt: "not-a-date" };
    const result = evaluateDaemonConflict(bad, opts(lastTickMs));
    expect(result).toEqual({ conflict: false, reason: "stale", pid: 1234 });
  });
});
