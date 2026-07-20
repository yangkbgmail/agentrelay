import { describe, expect, it } from "vitest";
import {
  classifyResumeLoop,
  DAEMON_HEARTBEAT_FILENAME,
  type DaemonHeartbeat,
  daemonHeartbeatPath,
  HEARTBEAT_MIN_STALE_AFTER_MS,
  HEARTBEAT_STALE_FACTOR,
  HEARTBEAT_TICK_STALE_AFTER_MS,
  heartbeatFactsFrom,
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

describe("heartbeatFactsFrom", () => {
  const now = Date.parse("2026-07-19T00:01:00.000Z");

  it("reads a null heartbeat as absent", () => {
    expect(heartbeatFactsFrom(null, now)).toEqual({ present: false });
  });

  it("reads an unparseable lastTickAt as absent", () => {
    const bad: DaemonHeartbeat = { ...sample, lastTickAt: "not-a-date" };
    expect(heartbeatFactsFrom(bad, now)).toEqual({ present: false });
  });

  it("derives age and staleAfter from a present heartbeat", () => {
    // sample last tick at 00:00:30, now 00:01:00 → 30s old
    const facts = heartbeatFactsFrom(sample, now);
    expect(facts.present).toBe(true);
    expect(facts.mode).toBe("daemon");
    expect(facts.pid).toBe(1234);
    expect(facts.ageMs).toBe(30_000);
    expect(facts.staleAfterMs).toBe(heartbeatStaleAfterMs("daemon", 30_000));
  });

  it("clamps a future lastTickAt (clock skew) to a non-negative age", () => {
    const future: DaemonHeartbeat = { ...sample, lastTickAt: "2027-01-01T00:00:00.000Z" };
    expect(heartbeatFactsFrom(future, now).ageMs).toBe(0);
  });
});

describe("classifyResumeLoop", () => {
  it("reports alive+ok when a fresh heartbeat is present", () => {
    const facts = { present: true, mode: "daemon" as const, pid: 42, ageMs: 5_000, staleAfterMs: 90_000 };
    const health = classifyResumeLoop(facts, 2);
    expect(health.state).toBe("alive");
    expect(health.level).toBe("ok");
    expect(health.waitingCount).toBe(2);
    expect(health.message).toContain("Resume loop alive");
    expect(health.message).toContain("pid 42");
    expect(health.message).toContain("2 waiting job(s) will resume");
  });

  it("reports stale+warning when a present heartbeat is past its window", () => {
    const facts = { present: true, mode: "daemon" as const, pid: 7, ageMs: 600_000, staleAfterMs: 90_000 };
    const health = classifyResumeLoop(facts, 3);
    expect(health.state).toBe("stale");
    expect(health.level).toBe("warning");
    expect(health.message).toContain("looks stopped");
    expect(health.message).toContain("3 job(s) are waiting");
  });

  it("still warns on a stale loop even with nothing waiting", () => {
    const facts = { present: true, mode: "tick" as const, ageMs: 3_600_000, staleAfterMs: 900_000 };
    const health = classifyResumeLoop(facts, 0);
    expect(health.state).toBe("stale");
    expect(health.level).toBe("warning");
  });

  it("warns when no loop is present but jobs are waiting", () => {
    const health = classifyResumeLoop({ present: false }, 4);
    expect(health.state).toBe("absent");
    expect(health.level).toBe("warning");
    expect(health.message).toContain("4 job(s) waiting to resume");
    expect(health.message).toContain("no resume loop is running");
  });

  it("stays ok when no loop is present and nothing is waiting", () => {
    const health = classifyResumeLoop({ present: false }, 0);
    expect(health.state).toBe("absent");
    expect(health.level).toBe("ok");
    expect(health.message).toContain("No resume loop running");
  });

  it("treats a present heartbeat missing age/staleAfter as stale, not alive", () => {
    const health = classifyResumeLoop({ present: true, mode: "daemon" }, 1);
    expect(health.state).toBe("stale");
    expect(health.level).toBe("warning");
  });

  it("normalizes a negative waiting count to zero", () => {
    const health = classifyResumeLoop({ present: false }, -5);
    expect(health.waitingCount).toBe(0);
    expect(health.level).toBe("ok");
  });
});
