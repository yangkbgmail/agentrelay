import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverviewReport } from "@agentrelay/core";
import { RelayQueue } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOverview, writeDaemonHeartbeat } from "../src/commands.js";
import { renderOverview, renderOverviewJson } from "../src/overview.js";

const AT = "2026-07-25T12:00:00.000Z";
const NOW = Date.parse(AT);

describe("readOverview (fs + clock half)", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-overview-test-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Queue one waiting job whose reset is `inMs` from NOW (negative = overdue). */
  function seedWaitingJob(inMs: number, project = "p"): void {
    const queue = new RelayQueue(storePath);
    const job = queue.enqueue({ project, tool: "claude-code", command: ["node", "--version"], cwd: dir });
    queue.markWaitingForReset(job.id, new Date(NOW + inMs).toISOString());
    queue.close();
  }

  function seedHeartbeat(agoMs: number, pollIntervalMs = 30_000): void {
    writeDaemonHeartbeat(storePath, {
      pid: 4242,
      mode: "daemon",
      startedAt: AT,
      lastTickAt: new Date(NOW - agoMs).toISOString(),
      pollIntervalMs,
    });
  }

  it("empty store → zeros, no next, idle health", () => {
    const report = readOverview({ storePath, nowMs: NOW });
    expect(report.total).toBe(0);
    expect(report.next).toBeNull();
    expect(report.health.level).toBe("idle");
  });

  it("a waiting job with no live loop → unhealthy, and surfaces the next resume", () => {
    seedWaitingJob(60 * 60_000); // due in 1h
    const report = readOverview({ storePath, nowMs: NOW });
    expect(report.total).toBe(1);
    expect(report.activeCount).toBe(1);
    expect(report.health.level).toBe("unhealthy");
    expect(report.next?.due).toBe(false);
    expect(report.overdue.count).toBe(0);
  });

  it("a fresh heartbeat flips the verdict to healthy", () => {
    seedWaitingJob(60 * 60_000);
    seedHeartbeat(5_000);
    const report = readOverview({ storePath, nowMs: NOW });
    expect(report.health.level).toBe("healthy");
  });

  it("counts overdue jobs and respects the grace window", () => {
    seedWaitingJob(-30 * 60_000); // 30m overdue
    seedWaitingJob(-10_000, "q"); // due 10s ago — inside a 60s grace
    const withGrace = readOverview({ storePath, nowMs: NOW, graceMs: 60_000 });
    expect(withGrace.overdue.count).toBe(1);
    const noGrace = readOverview({ storePath, nowMs: NOW, graceMs: 0 });
    expect(noGrace.overdue.count).toBe(2);
  });

  it("lists top pending-work projects, capped by topProjects", () => {
    seedWaitingJob(60 * 60_000, "alpha");
    seedWaitingJob(60 * 60_000, "beta");
    const report = readOverview({ storePath, nowMs: NOW, topProjects: 1 });
    expect(report.topProjects).toHaveLength(1);
  });
});

describe("renderOverview", () => {
  function baseReport(overrides: Partial<OverviewReport> = {}): OverviewReport {
    return {
      total: 3,
      byStatus: {
        queued: 1,
        waiting_for_reset: 1,
        resuming: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
      },
      activeCount: 2,
      terminalCount: 1,
      health: {
        level: "healthy",
        exitCode: 0,
        reason: "resume loop alive",
        heartbeat: { state: "alive", mode: "daemon", pid: 42, waitingJobs: 2, concerning: false, ageMs: 3000 },
      },
      next: null,
      overdue: { count: 0, maxOverdueByMs: 0 },
      topProjects: [],
      ...overrides,
    };
  }

  it("empty store shows the onboarding message", () => {
    const line = renderOverview(baseReport({ total: 0 }), { now: NOW });
    expect(line).toContain("No jobs yet");
  });

  it("renders header, health verdict, and per-status counts", () => {
    const out = renderOverview(baseReport(), { now: NOW });
    expect(out).toContain("AgentRelay overview");
    expect(out).toContain("3 job(s) tracked");
    expect(out).toContain("HEALTHY");
    expect(out).toContain("queued 1");
    expect(out).toContain("waiting 1");
    expect(out).toContain("completed 1");
  });

  it("only shows an overdue line when the relay has fallen behind", () => {
    const none = renderOverview(baseReport(), { now: NOW });
    expect(none).not.toContain("overdue");

    const behind = renderOverview(baseReport({ overdue: { count: 2, maxOverdueByMs: 3 * 60_000 } }), { now: NOW });
    expect(behind).toContain("2 jobs overdue");
    expect(behind).toContain("worst 3m 0s behind");
  });

  it("lists pending projects when present", () => {
    const out = renderOverview(
      baseReport({
        topProjects: [
          {
            project: "alpha",
            total: 2,
            active: 2,
            terminal: 0,
            waiting: 1,
            nextResetAt: "2026-07-25T13:00:00.000Z",
            lastActivityAt: AT,
          },
        ],
      }),
      { now: NOW }
    );
    expect(out).toContain("pending by project");
    expect(out).toContain("alpha");
  });

  it("has no ANSI codes when color is off, some when on", () => {
    expect(renderOverview(baseReport(), { now: NOW })).not.toContain("\x1b[");
    expect(renderOverview(baseReport(), { now: NOW, color: true })).toContain("\x1b[");
  });

  it("renderOverviewJson round-trips the report plus store + timestamp", () => {
    const json = JSON.parse(
      renderOverviewJson({ storePath: "/tmp/jobs.json", generatedAt: AT, overview: baseReport() })
    );
    expect(json.storePath).toBe("/tmp/jobs.json");
    expect(json.generatedAt).toBe(AT);
    expect(json.overview.total).toBe(3);
    expect(json.overview.health.level).toBe("healthy");
  });
});
