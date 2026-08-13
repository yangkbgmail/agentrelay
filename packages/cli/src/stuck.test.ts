import type { RelayJob, StuckReport } from "@agentrelay/core";
import { buildStuckReport } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_STUCK_MESSAGE, renderStuck, renderStuckJson } from "./stuck.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `abcdef${seq}0000`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "resuming",
    resetAt: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-30T10:00:00.000Z");

function emptyReport(overrides: Partial<StuckReport> = {}): StuckReport {
  return {
    entries: [],
    totalStuck: 0,
    hidden: 0,
    thresholdMs: 15 * 60_000,
    maxIdleMs: 0,
    statuses: ["queued", "resuming"],
    ...overrides,
  };
}

describe("renderStuck", () => {
  it("shows the reassuring message with threshold + statuses when nothing is stuck", () => {
    const out = renderStuck(emptyReport());
    expect(out).toContain(NO_STUCK_MESSAGE);
    expect(out).toContain("threshold 15m");
    expect(out).toContain("queued/resuming");
  });

  it("appends the scope note to the empty message when scoped", () => {
    const out = renderStuck(emptyReport(), { scopeNote: "project=web" });
    expect(out).toContain("[scope: project=web]");
  });

  it("renders a table row per stuck job with id/project/status/idle", () => {
    const report = buildStuckReport(
      [job({ id: "deadbeef1111", status: "resuming", updatedAt: "2026-07-30T08:00:00.000Z" })],
      NOW
    );
    const out = renderStuck(report);
    expect(out).toContain("STATUS");
    expect(out).toContain("deadbeef"); // short id (8 chars)
    expect(out).toContain("resuming");
    expect(out).toContain("2h"); // idle span
    expect(out).toContain("1 job stuck");
  });

  it("pluralizes and reports hidden rows in the footer", () => {
    const jobs = [
      job({ status: "queued", updatedAt: "2026-07-30T08:00:00.000Z" }),
      job({ status: "resuming", updatedAt: "2026-07-30T08:30:00.000Z" }),
    ];
    const out = renderStuck(buildStuckReport(jobs, NOW, { limit: 1 }));
    expect(out).toContain("2 jobs stuck");
    expect(out).toContain("1 more not shown");
  });

  it("emits no ANSI codes when color is off, and some when on", () => {
    const report = buildStuckReport([job({ updatedAt: "2026-07-30T08:00:00.000Z" })], NOW);
    expect(renderStuck(report, { color: false })).not.toContain("\x1b[");
    expect(renderStuck(report, { color: true })).toContain("\x1b[");
  });
});

describe("renderStuckJson", () => {
  it("wraps the report with provenance and round-trips the entries", () => {
    const report = buildStuckReport([job({ id: "cafe00001111", updatedAt: "2026-07-30T08:00:00.000Z" })], NOW);
    const parsed = JSON.parse(
      renderStuckJson({ storePath: "/x/jobs.json", generatedAt: "2026-07-30T10:00:00.000Z", report })
    );
    expect(parsed.storePath).toBe("/x/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.report.totalStuck).toBe(1);
    expect(parsed.report.entries[0].job.id).toBe("cafe00001111");
    expect(parsed.report.entries[0].idleMs).toBe(2 * 60 * 60 * 1000);
    expect(parsed.report.statuses).toEqual(["queued", "resuming"]);
  });

  it("includes the active scope when provided", () => {
    const parsed = JSON.parse(
      renderStuckJson({ storePath: "/x/jobs.json", scope: { project: ["web"] }, report: emptyReport() })
    );
    expect(parsed.scope).toEqual({ project: ["web"] });
  });
});
