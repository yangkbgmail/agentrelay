import { describe, expect, it } from "vitest";
import type { HeartbeatStatus } from "./heartbeat.js";
import { buildOverview } from "./overview.js";
import type { RelayJob } from "./types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-13T12:00:00.000Z");

/** A live heartbeat with no jobs waiting. */
function aliveHeartbeat(waitingJobs = 0): HeartbeatStatus {
  return {
    state: "alive",
    mode: "daemon",
    pid: 4321,
    lastTickAt: "2026-07-13T11:59:57.000Z",
    ageMs: 3000,
    staleAfterMs: 60_000,
    waitingJobs,
    concerning: false,
  };
}

/** An absent heartbeat (no resume loop) that's concerning when jobs wait. */
function absentHeartbeat(waitingJobs: number): HeartbeatStatus {
  return { state: "absent", waitingJobs, concerning: waitingJobs > 0 };
}

describe("buildOverview", () => {
  it("returns an empty-but-well-formed shape for no jobs", () => {
    const report = buildOverview([], { now: NOW, heartbeat: aliveHeartbeat(0) });
    expect(report.total).toBe(0);
    expect(report.activeCount).toBe(0);
    expect(report.terminalCount).toBe(0);
    expect(report.next).toBeNull();
    expect(report.overdue).toEqual({ count: 0, maxOverdueByMs: 0 });
    expect(report.topProjects).toEqual([]);
    // Every status is zero-filled.
    expect(report.byStatus).toMatchObject({ queued: 0, waiting_for_reset: 0, completed: 0 });
    expect(report.health.level).toBe("healthy");
  });

  it("splits active vs terminal counts and zero-fills byStatus", () => {
    const report = buildOverview(
      [
        job({ status: "queued" }),
        job({ status: "waiting_for_reset", resetAt: "2026-07-13T13:00:00.000Z" }),
        job({ status: "resuming" }),
        job({ status: "completed" }),
        job({ status: "failed" }),
        job({ status: "cancelled" }),
      ],
      { now: NOW, heartbeat: aliveHeartbeat(3) }
    );
    expect(report.total).toBe(6);
    expect(report.activeCount).toBe(3); // queued + waiting_for_reset + resuming
    expect(report.terminalCount).toBe(3); // completed + failed + cancelled
    expect(report.byStatus.queued).toBe(1);
    expect(report.byStatus.waiting_for_reset).toBe(1);
    expect(report.byStatus.cancelled).toBe(1);
  });

  it("surfaces the next resume via selectNextResume (earliest reset wins)", () => {
    const report = buildOverview(
      [
        job({ status: "waiting_for_reset", resetAt: "2026-07-13T14:00:00.000Z", project: "later" }),
        job({ status: "waiting_for_reset", resetAt: "2026-07-13T13:00:00.000Z", project: "sooner" }),
      ],
      { now: NOW, heartbeat: aliveHeartbeat(2) }
    );
    expect(report.next?.job.project).toBe("sooner");
    expect(report.next?.due).toBe(false);
    expect(report.next?.waitingBehind).toBe(1);
    expect(report.next?.dueInMs).toBe(60 * 60 * 1000);
  });

  it("counts overdue jobs and the worst span, honoring graceMs", () => {
    const report = buildOverview(
      [
        // 30m overdue
        job({ status: "waiting_for_reset", resetAt: "2026-07-13T11:30:00.000Z" }),
        // 2h overdue (worst)
        job({ status: "waiting_for_reset", resetAt: "2026-07-13T10:00:00.000Z" }),
        // due 10s ago — inside a 60s grace, not overdue
        job({ status: "waiting_for_reset", resetAt: "2026-07-13T11:59:50.000Z" }),
      ],
      { now: NOW, heartbeat: absentHeartbeat(3), graceMs: 60_000 }
    );
    expect(report.overdue.count).toBe(2);
    expect(report.overdue.maxOverdueByMs).toBe(2 * 60 * 60 * 1000);
  });

  it("marks the health verdict unhealthy when jobs wait with no live loop", () => {
    const report = buildOverview([job({ status: "waiting_for_reset", resetAt: "2026-07-13T13:00:00.000Z" })], {
      now: NOW,
      heartbeat: absentHeartbeat(1),
    });
    expect(report.health.level).toBe("unhealthy");
    expect(report.health.exitCode).toBe(1);
  });

  it("stays idle (healthy exit) when the loop is down but nothing waits, unless strict", () => {
    const jobs = [job({ status: "completed" })];
    const relaxed = buildOverview(jobs, { now: NOW, heartbeat: absentHeartbeat(0) });
    expect(relaxed.health.level).toBe("idle");
    expect(relaxed.health.exitCode).toBe(0);

    const strict = buildOverview(jobs, { now: NOW, heartbeat: absentHeartbeat(0), strict: true });
    expect(strict.health.level).toBe("unhealthy");
    expect(strict.health.exitCode).toBe(1);
  });

  it("lists only pending-work projects, ranked, trimmed to topProjects", () => {
    const report = buildOverview(
      [
        job({ project: "busy", status: "queued" }),
        job({ project: "busy", status: "waiting_for_reset", resetAt: "2026-07-13T13:00:00.000Z" }),
        job({ project: "some", status: "resuming" }),
        job({ project: "idle", status: "completed" }), // no active work → excluded
      ],
      { now: NOW, heartbeat: aliveHeartbeat(3), topProjects: 5 }
    );
    expect(report.topProjects.map((p) => p.project)).toEqual(["busy", "some"]);
    expect(report.topProjects[0]).toMatchObject({ active: 2, waiting: 1 });
  });

  it("respects a topProjects cap and returns none when it is 0", () => {
    const jobs = [
      job({ project: "a", status: "queued" }),
      job({ project: "b", status: "queued" }),
      job({ project: "c", status: "queued" }),
    ];
    expect(buildOverview(jobs, { now: NOW, heartbeat: aliveHeartbeat(3), topProjects: 2 }).topProjects).toHaveLength(2);
    expect(buildOverview(jobs, { now: NOW, heartbeat: aliveHeartbeat(3), topProjects: 0 }).topProjects).toHaveLength(0);
  });

  it("does not mutate the input job list", () => {
    const jobs = [
      job({ status: "waiting_for_reset", resetAt: "2026-07-13T13:00:00.000Z" }),
      job({ status: "completed" }),
    ];
    const snapshot = jobs.map((j) => ({ ...j }));
    buildOverview(jobs, { now: NOW, heartbeat: aliveHeartbeat(1) });
    expect(jobs).toEqual(snapshot);
  });
});
