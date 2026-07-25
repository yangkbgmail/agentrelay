import { describe, expect, it } from "vitest";
import { evaluateHealth, HEALTH_EXIT_OK, HEALTH_EXIT_UNHEALTHY } from "./health.js";
import { type DaemonHeartbeat, evaluateHeartbeat, type HeartbeatStatus } from "./heartbeat.js";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");

function heartbeat(overrides: Partial<DaemonHeartbeat> = {}): DaemonHeartbeat {
  return {
    pid: 4242,
    mode: "daemon",
    startedAt: "2026-07-25T11:00:00.000Z",
    lastTickAt: "2026-07-25T11:59:58.000Z",
    pollIntervalMs: 5_000,
    ...overrides,
  };
}

/** Build a HeartbeatStatus directly (skip evaluateHeartbeat) for edge cases. */
function status(overrides: Partial<HeartbeatStatus>): HeartbeatStatus {
  return {
    state: "alive",
    waitingJobs: 0,
    concerning: false,
    ...overrides,
  };
}

describe("evaluateHealth", () => {
  it("alive loop is healthy (exit 0), regardless of waiting jobs", () => {
    const hb = evaluateHeartbeat(heartbeat(), { nowMs: NOW, waitingJobs: 3 });
    const report = evaluateHealth(hb);
    expect(report.level).toBe("healthy");
    expect(report.exitCode).toBe(HEALTH_EXIT_OK);
    expect(report.reason).toMatch(/alive/);
    expect(report.heartbeat).toBe(hb);
  });

  it("stale loop with jobs waiting is unhealthy (exit 1)", () => {
    // Last tick 10 minutes ago, far beyond the daemon staleness window.
    const hb = evaluateHeartbeat(heartbeat({ lastTickAt: "2026-07-25T11:50:00.000Z" }), {
      nowMs: NOW,
      waitingJobs: 2,
    });
    expect(hb.state).toBe("stale");
    const report = evaluateHealth(hb);
    expect(report.level).toBe("unhealthy");
    expect(report.exitCode).toBe(HEALTH_EXIT_UNHEALTHY);
    expect(report.reason).toContain("2 job(s) waiting");
  });

  it("absent loop with jobs waiting is unhealthy (exit 1)", () => {
    const hb = evaluateHeartbeat(null, { nowMs: NOW, waitingJobs: 1 });
    expect(hb.state).toBe("absent");
    const report = evaluateHealth(hb);
    expect(report.level).toBe("unhealthy");
    expect(report.exitCode).toBe(HEALTH_EXIT_UNHEALTHY);
    expect(report.reason).toContain("1 job(s) waiting");
  });

  it("stale loop with nothing waiting is idle (exit 0) by default", () => {
    const hb = evaluateHeartbeat(heartbeat({ lastTickAt: "2026-07-25T11:50:00.000Z" }), {
      nowMs: NOW,
      waitingJobs: 0,
    });
    expect(hb.state).toBe("stale");
    const report = evaluateHealth(hb);
    expect(report.level).toBe("idle");
    expect(report.exitCode).toBe(HEALTH_EXIT_OK);
    expect(report.reason).toMatch(/nothing waiting/);
  });

  it("absent loop with nothing waiting is idle (exit 0) by default", () => {
    const hb = evaluateHeartbeat(null, { nowMs: NOW, waitingJobs: 0 });
    const report = evaluateHealth(hb);
    expect(report.level).toBe("idle");
    expect(report.exitCode).toBe(HEALTH_EXIT_OK);
  });

  it("strict mode turns idle into unhealthy (exit 1)", () => {
    const hb = evaluateHeartbeat(null, { nowMs: NOW, waitingJobs: 0 });
    const report = evaluateHealth(hb, { strict: true });
    expect(report.level).toBe("unhealthy");
    expect(report.exitCode).toBe(HEALTH_EXIT_UNHEALTHY);
    expect(report.reason).toContain("strict");
  });

  it("strict mode leaves a healthy loop healthy", () => {
    const hb = evaluateHeartbeat(heartbeat(), { nowMs: NOW, waitingJobs: 0 });
    const report = evaluateHealth(hb, { strict: true });
    expect(report.level).toBe("healthy");
    expect(report.exitCode).toBe(HEALTH_EXIT_OK);
  });

  it("strict mode still reports unhealthy (not a special idle) when jobs are stranded", () => {
    const hb = evaluateHeartbeat(null, { nowMs: NOW, waitingJobs: 5 });
    const report = evaluateHealth(hb, { strict: true });
    expect(report.level).toBe("unhealthy");
    expect(report.reason).toContain("5 job(s) waiting");
  });

  it("names the underlying state (stale vs absent) in the unhealthy reason", () => {
    const staleReport = evaluateHealth(status({ state: "stale", waitingJobs: 1, concerning: true }));
    expect(staleReport.reason).toContain("stale");
    const absentReport = evaluateHealth(status({ state: "absent", waitingJobs: 1, concerning: true }));
    expect(absentReport.reason).toContain("absent");
  });

  it("echoes the heartbeat status unchanged for --json consumers", () => {
    const s = status({ state: "alive", mode: "tick", pid: 99, waitingJobs: 0, concerning: false });
    expect(evaluateHealth(s).heartbeat).toBe(s);
  });
});
