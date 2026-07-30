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

describe("buildOverdueReport", () => {
  it("returns an empty report when nothing is overdue", () => {
    const report = buildOverdueReport([], NOW);
    expect(report).toEqual({ entries: [], totalOverdue: 0, hidden: 0, worstOverdueByMs: 0 });
  });

  it("only counts waiting_for_reset jobs whose reset is in the past", () => {
    const report = buildOverdueReport(
      [
        job({ id: "overdue", resetAt: "2026-07-30T09:00:00.000Z" }),
        job({ id: "future", resetAt: "2026-07-30T11:00:00.000Z" }),
        job({ id: "done", status: "completed", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ id: "resuming", status: "resuming", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.totalOverdue).toBe(1);
    expect(report.entries.map((e) => e.job.id)).toEqual(["overdue"]);
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
    expect(report.entries.map((e) => e.job.id)).toEqual(["good"]);
  });

  it("treats a reset exactly at now as overdue by zero (still due)", () => {
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T10:00:00.000Z" })], NOW);
    expect(report.totalOverdue).toBe(1);
    expect(report.entries[0]?.overdueByMs).toBe(0);
  });

  it("orders entries most-overdue first and numbers positions from 1", () => {
    const report = buildOverdueReport(
      [
        job({ id: "slightly", resetAt: "2026-07-30T09:50:00.000Z" }),
        job({ id: "very", resetAt: "2026-07-30T07:00:00.000Z" }),
        job({ id: "mid", resetAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["very", "mid", "slightly"]);
    expect(report.entries.map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it("breaks ties deterministically by createdAt then id", () => {
    const report = buildOverdueReport(
      [
        job({ id: "b", resetAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "a", resetAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "c", resetAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
      ],
      NOW
    );
    // Same overdue span → oldest createdAt first (c), then id order (a before b).
    expect(report.entries.map((e) => e.job.id)).toEqual(["c", "a", "b"]);
  });

  it("computes overdueByMs and the worst span across the full set", () => {
    const report = buildOverdueReport(
      [
        job({ id: "one-hour", resetAt: "2026-07-30T09:00:00.000Z" }),
        job({ id: "three-hours", resetAt: "2026-07-30T07:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.find((e) => e.job.id === "one-hour")?.overdueByMs).toBe(60 * 60 * 1000);
    expect(report.entries.find((e) => e.job.id === "three-hours")?.overdueByMs).toBe(3 * 60 * 60 * 1000);
    expect(report.worstOverdueByMs).toBe(3 * 60 * 60 * 1000);
  });

  it("filters by minOverdueMs so just-came-due jobs are excluded", () => {
    const report = buildOverdueReport(
      [
        job({ id: "barely", resetAt: "2026-07-30T09:59:00.000Z" }), // 1m overdue
        job({ id: "stuck", resetAt: "2026-07-30T09:00:00.000Z" }), // 1h overdue
      ],
      NOW,
      { minOverdueMs: 5 * 60 * 1000 } // 5m threshold
    );
    expect(report.totalOverdue).toBe(1);
    expect(report.entries.map((e) => e.job.id)).toEqual(["stuck"]);
  });

  it("trims to the limit while keeping totals and worst honest", () => {
    const report = buildOverdueReport(
      [
        job({ id: "j1", resetAt: "2026-07-30T05:00:00.000Z" }), // most overdue
        job({ id: "j2", resetAt: "2026-07-30T06:00:00.000Z" }),
        job({ id: "j3", resetAt: "2026-07-30T07:00:00.000Z" }),
      ],
      NOW,
      { limit: 1 }
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["j1"]);
    expect(report.totalOverdue).toBe(3);
    expect(report.hidden).toBe(2);
    expect(report.worstOverdueByMs).toBe(5 * 60 * 60 * 1000);
  });

  it("does not mutate the input array order", () => {
    const jobs = [
      job({ id: "slightly", resetAt: "2026-07-30T09:50:00.000Z" }),
      job({ id: "very", resetAt: "2026-07-30T07:00:00.000Z" }),
    ];
    buildOverdueReport(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(["slightly", "very"]);
  });
});
