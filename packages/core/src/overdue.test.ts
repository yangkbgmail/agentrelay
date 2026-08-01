import { describe, expect, it } from "vitest";
import { buildOverdueReport } from "./overdue.js";
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
    status: "waiting_for_reset",
    resetAt: "2026-07-30T09:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-30T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describe("buildOverdueReport", () => {
  it("returns an empty report when nothing is overdue", () => {
    const report = buildOverdueReport([], NOW);
    expect(report).toEqual({ entries: [], totalOverdue: 0, hidden: 0, maxOverdueByMs: 0 });
  });

  it("ignores jobs that are not waiting_for_reset even if their resetAt is past", () => {
    const report = buildOverdueReport(
      [
        job({ status: "completed", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "queued", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "resuming", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "failed", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.totalOverdue).toBe(0);
    expect(report.entries).toHaveLength(0);
  });

  it("ignores waiting jobs whose reset is still in the future", () => {
    const report = buildOverdueReport([job({ id: "future", resetAt: "2026-07-30T11:00:00.000Z" })], NOW);
    expect(report.totalOverdue).toBe(0);
  });

  it("does not count a reset exactly at now (due, but not yet late)", () => {
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T10:00:00.000Z" })], NOW);
    expect(report.totalOverdue).toBe(0);
  });

  it("ignores waiting jobs with a missing or unparseable resetAt", () => {
    const report = buildOverdueReport(
      [
        job({ id: "no-reset", resetAt: null }),
        job({ id: "bad-reset", resetAt: "not a date" }),
        job({ id: "good", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.totalOverdue).toBe(1);
    expect(report.entries.map((e) => e.job.id)).toEqual(["good"]);
  });

  it("ranks the most overdue first and numbers positions from 1", () => {
    const report = buildOverdueReport(
      [
        job({ id: "barely", resetAt: "2026-07-30T09:30:00.000Z" }),
        job({ id: "worst", resetAt: "2026-07-30T06:00:00.000Z" }),
        job({ id: "middle", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["worst", "middle", "barely"]);
    expect(report.entries.map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it("breaks ties deterministically by createdAt then id", () => {
    const report = buildOverdueReport(
      [
        job({ id: "b", resetAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "a", resetAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "c", resetAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["c", "a", "b"]);
  });

  it("computes overdueByMs and maxOverdueByMs against now", () => {
    const report = buildOverdueReport(
      [
        job({ id: "one-hour", resetAt: "2026-07-30T09:00:00.000Z" }),
        job({ id: "four-hours", resetAt: "2026-07-30T06:00:00.000Z" }),
      ],
      NOW
    );
    const oneHour = report.entries.find((e) => e.job.id === "one-hour");
    const fourHours = report.entries.find((e) => e.job.id === "four-hours");
    expect(oneHour?.overdueByMs).toBe(HOUR);
    expect(fourHours?.overdueByMs).toBe(4 * HOUR);
    expect(report.maxOverdueByMs).toBe(4 * HOUR);
  });

  it("honours a grace window so jobs only slightly late are not flagged", () => {
    const report = buildOverdueReport(
      [
        job({ id: "5s-late", resetAt: "2026-07-30T09:59:55.000Z" }),
        job({ id: "5m-late", resetAt: "2026-07-30T09:55:00.000Z" }),
      ],
      NOW,
      { graceMs: 60 * 1000 }
    );
    // Only the job more than 60s past due survives the grace window.
    expect(report.entries.map((e) => e.job.id)).toEqual(["5m-late"]);
    expect(report.totalOverdue).toBe(1);
  });

  it("trims to the limit while keeping totals honest", () => {
    const report = buildOverdueReport(
      [
        job({ id: "j1", resetAt: "2026-07-30T06:00:00.000Z" }),
        job({ id: "j2", resetAt: "2026-07-30T07:00:00.000Z" }),
        job({ id: "j3", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ id: "j4", resetAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW,
      { limit: 2 }
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["j1", "j2"]);
    expect(report.totalOverdue).toBe(4);
    expect(report.hidden).toBe(2);
    // maxOverdueByMs still reflects the worst job across the full set.
    expect(report.maxOverdueByMs).toBe(4 * HOUR);
  });

  it("does not mutate the input array order", () => {
    const jobs = [
      job({ id: "barely", resetAt: "2026-07-30T09:30:00.000Z" }),
      job({ id: "worst", resetAt: "2026-07-30T06:00:00.000Z" }),
    ];
    buildOverdueReport(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(["barely", "worst"]);
  });
});
