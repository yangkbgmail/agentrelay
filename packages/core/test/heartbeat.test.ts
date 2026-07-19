import { describe, expect, it } from "vitest";
import {
  DAEMON_HEARTBEAT_FILENAME,
  type DaemonHeartbeat,
  daemonHeartbeatPath,
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
