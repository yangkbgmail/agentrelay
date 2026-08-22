import type { HealthReport, OverdueReport, QueueEta, RelayJob, UpcomingTimeline } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  type DashboardData,
  renderDashboard,
  renderDashboardFrame,
  renderDashboardJson,
  renderOverdueCallout,
} from "../src/watch.js";

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "aaaa1111-0000-0000-0000-000000000001",
    project: "web-app",
    tool: "claude-code",
    cwd: "/w",
    command: ["claude", "-p", "go"],
    status: "waiting_for_reset",
    resetAt: "2026-07-30T15:00:00.000Z",
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T11:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    lastRateLimit: null,
    ...overrides,
  };
}

function health(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    level: "healthy",
    exitCode: 0,
    reason: "resume loop alive",
    heartbeat: { state: "alive", mode: "daemon", pid: 4242, ageMs: 3000, waitingJobs: 2, concerning: false },
    ...overrides,
  };
}

function caughtUpEta(): QueueEta {
  return {
    waiting: 0,
    dueNow: 0,
    firstResetAt: null,
    lastResetAt: null,
    etaMs: null,
    spanMs: null,
    caughtUp: true,
  };
}

function waitingEta(overrides: Partial<QueueEta> = {}): QueueEta {
  return {
    waiting: 2,
    dueNow: 0,
    firstResetAt: "2026-07-30T14:00:00.000Z",
    lastResetAt: "2026-07-30T15:00:00.000Z",
    etaMs: 60 * 60 * 1000,
    spanMs: 60 * 60 * 1000,
    caughtUp: false,
    ...overrides,
  };
}

function noOverdue(): OverdueReport {
  return { entries: [], totalOverdue: 0, hidden: 0, graceMs: 60_000, maxOverdueByMs: 0 };
}

function overdue(overrides: Partial<OverdueReport> = {}): OverdueReport {
  return {
    entries: [{ job: job({ id: "bbbb2222-0000-0000-0000-000000000002", project: "api-svc" }), overdueByMs: 3_600_000 }],
    totalOverdue: 1,
    hidden: 0,
    graceMs: 60_000,
    maxOverdueByMs: 3_600_000,
    ...overrides,
  };
}

function emptyTimeline(): UpcomingTimeline {
  return { entries: [], totalWaiting: 0, hidden: 0, dueNow: 0 };
}

function timeline(): UpcomingTimeline {
  return {
    entries: [
      {
        job: job({ id: "cccc3333-0000-0000-0000-000000000003", project: "web-app" }),
        dueInMs: 60_000,
        due: false,
        position: 1,
      },
    ],
    totalWaiting: 1,
    hidden: 0,
    dueNow: 0,
  };
}

function data(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    health: health(),
    eta: waitingEta(),
    overdue: noOverdue(),
    upcoming: timeline(),
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-30T14:30:00.000Z");

describe("renderOverdueCallout", () => {
  it("is empty when nothing is overdue (so the section is dropped)", () => {
    expect(renderOverdueCallout(noOverdue())).toBe("");
  });

  it("names the overdue count and the worst span with a diagnostic hint", () => {
    const out = renderOverdueCallout(overdue());
    expect(out).toContain("Overdue: 1 job past due by up to 1h 0m");
    expect(out).toContain("agentrelay overdue");
    expect(out).toContain("agentrelay doctor");
  });

  it("uses the plural form for more than one overdue job", () => {
    const out = renderOverdueCallout(overdue({ totalOverdue: 3 }));
    expect(out).toContain("3 jobs past due");
  });
});

describe("renderDashboard", () => {
  it("stacks the four sections in order: health, eta, upcoming (overdue dropped when clean)", () => {
    const out = renderDashboard(data(), { now: NOW });
    const loop = out.indexOf("Resume loop");
    const eta = out.indexOf("Queue ETA");
    const upcoming = out.indexOf("Upcoming");
    expect(loop).toBeGreaterThanOrEqual(0);
    expect(eta).toBeGreaterThan(loop);
    expect(upcoming).toBeGreaterThan(eta);
    // A clean relay shows no overdue alarm line.
    expect(out).not.toContain("Overdue:");
  });

  it("surfaces the health verdict, the eta countdown, and the upcoming rows", () => {
    const out = renderDashboard(data(), { now: NOW });
    expect(out).toContain("HEALTHY");
    expect(out).toContain("resume loop alive");
    expect(out).toContain("Queue caught up in 1h 0m");
    expect(out).toContain("cccc3333"); // upcoming row's short id
  });

  it("inserts the overdue callout between eta and upcoming when jobs are overdue", () => {
    const out = renderDashboard(data({ overdue: overdue() }), { now: NOW });
    const eta = out.indexOf("Queue ETA");
    const callout = out.indexOf("Overdue:");
    const upcoming = out.indexOf("Upcoming");
    expect(callout).toBeGreaterThan(eta);
    expect(upcoming).toBeGreaterThan(callout);
  });

  it("shows an unhealthy loop and a caught-up queue on an empty store", () => {
    const out = renderDashboard(
      data({
        health: health({
          level: "idle",
          exitCode: 0,
          reason: "resume loop absent, nothing waiting",
          heartbeat: { state: "absent", waitingJobs: 0, concerning: false },
        }),
        eta: caughtUpEta(),
        upcoming: emptyTimeline(),
      }),
      { now: NOW }
    );
    expect(out).toContain("IDLE");
    expect(out).toContain("Queue is caught up");
    expect(out).toContain("No jobs waiting for a reset.");
  });

  it("emits no ANSI codes when color is off", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderDashboard(data({ overdue: overdue() }), { now: NOW, color: false })).not.toMatch(/\x1b\[/);
  });

  it("echoes an active scope note", () => {
    const out = renderDashboard(data(), { now: NOW, scopeNote: "project=web-app" });
    expect(out).toContain("scope: project=web-app");
  });
});

describe("renderDashboardFrame", () => {
  it("wraps the dashboard in a live banner with the interval, store, and timestamp", () => {
    const frame = renderDashboardFrame(data(), "/tmp/jobs.json", 2000, NOW);
    expect(frame).toContain("agentrelay watch");
    expect(frame).toContain("every 2s");
    expect(frame).toContain("/tmp/jobs.json");
    expect(frame).toContain("2026-07-30 14:30:00Z");
    expect(frame).toContain("Resume loop");
  });
});

describe("renderDashboardJson", () => {
  it("carries every underlying report plus store, timestamp, and scope", () => {
    const parsed = JSON.parse(
      renderDashboardJson({
        storePath: "/tmp/jobs.json",
        generatedAt: "2026-07-30T14:30:00.000Z",
        scope: { projects: ["web-app"] },
        data: data({ overdue: overdue() }),
      })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T14:30:00.000Z");
    expect(parsed.scope).toEqual({ projects: ["web-app"] });
    expect(parsed.health.level).toBe("healthy");
    expect(parsed.eta.waiting).toBe(2);
    expect(parsed.overdue.totalOverdue).toBe(1);
    expect(parsed.upcoming.totalWaiting).toBe(1);
  });

  it("omits scope when none is active", () => {
    const parsed = JSON.parse(renderDashboardJson({ storePath: "/tmp/jobs.json", data: data() }));
    expect(parsed.scope).toBeUndefined();
  });
});
