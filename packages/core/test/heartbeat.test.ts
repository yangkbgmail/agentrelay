import { describe, expect, it } from "vitest";
import {
  DAEMON_HEARTBEAT_FILENAME,
  type DaemonHeartbeat,
  daemonHeartbeatPath,
  evaluateHeartbeat,
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

describe("evaluateHeartbeat", () => {
  const lastTick = new Date(sample.lastTickAt).getTime();

  it("reports absent when there is no heartbeat", () => {
    const status = evaluateHeartbeat(null, { nowMs: lastTick, waitingJobs: 0 });
    expect(status).toEqual({ state: "absent", waitingJobs: 0, concerning: false });
  });

  it("flags an absent heartbeat as concerning when jobs are waiting", () => {
    const status = evaluateHeartbeat(null, { nowMs: lastTick, waitingJobs: 3 });
    expect(status.state).toBe("absent");
    expect(status.waitingJobs).toBe(3);
    expect(status.concerning).toBe(true);
  });

  it("reports alive when a daemon ticked within its staleness window", () => {
    // 45s after last tick; window is 30s poll * 3 = 90s
    const status = evaluateHeartbeat(sample, { nowMs: lastTick + 45_000, waitingJobs: 2 });
    expect(status.state).toBe("alive");
    expect(status.mode).toBe("daemon");
    expect(status.pid).toBe(1234);
    expect(status.lastTickAt).toBe(sample.lastTickAt);
    expect(status.ageMs).toBe(45_000);
    expect(status.staleAfterMs).toBe(90_000);
    expect(status.concerning).toBe(false);
  });

  it("reports stale (and concerning) once past the window with jobs waiting", () => {
    const status = evaluateHeartbeat(sample, { nowMs: lastTick + 120_000, waitingJobs: 1 });
    expect(status.state).toBe("stale");
    expect(status.ageMs).toBe(120_000);
    expect(status.concerning).toBe(true);
  });

  it("reports stale but not concerning when nothing is waiting", () => {
    const status = evaluateHeartbeat(sample, { nowMs: lastTick + 120_000, waitingJobs: 0 });
    expect(status.state).toBe("stale");
    expect(status.concerning).toBe(false);
  });

  it("treats an unparseable lastTickAt as stale with no ageMs", () => {
    const bad: DaemonHeartbeat = { ...sample, lastTickAt: "not-a-date" };
    const status = evaluateHeartbeat(bad, { nowMs: lastTick, waitingJobs: 1 });
    expect(status.state).toBe("stale");
    expect(status.ageMs).toBeUndefined();
    expect(status.concerning).toBe(true);
  });

  it("treats a future tick (clock skew) as alive", () => {
    const status = evaluateHeartbeat(sample, { nowMs: lastTick - 5_000, waitingJobs: 0 });
    expect(status.state).toBe("alive");
    expect(status.ageMs).toBe(-5_000);
  });

  it("floors a negative waiting count to zero", () => {
    const status = evaluateHeartbeat(null, { nowMs: lastTick, waitingJobs: -4 });
    expect(status.waitingJobs).toBe(0);
    expect(status.concerning).toBe(false);
  });
});
