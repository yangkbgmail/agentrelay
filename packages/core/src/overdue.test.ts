import { describe, expect, it } from "vitest";
import { buildOverdueReport, DEFAULT_OVERDUE_GRACE_MS } from "./overdue.js";
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
  it("returns an empty report when nothing is waiting", () => {
    const report = buildOverdueReport([], NOW);
    expect(report).toEqual({
      entries: [],
      totalWaiting: 0,
      overdueCount: 0,
      concerningCount: 0,
      hidden: 0,
      graceMs: DEFAULT_OVERDUE_GRACE_MS,
      worstOverdueMs: null,
    });
  });

  it("ignores jobs that are not waiting_for_reset", () => {
    const report = buildOverdueReport(
      [
        job({ status: "completed", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "queued", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "resuming", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "failed", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.totalWaiting).toBe(0);
    expect(report.overdueCount).toBe(0);
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
    expect(report.totalWaiting).toBe(1);
    expect(report.entries.map((e) => e.job.id)).toEqual(["good"]);
  });

  it("only counts jobs whose reset time is at or before now", () => {
    const report = buildOverdueReport(
      [
        job({ id: "past", resetAt: "2026-07-30T09:00:00.000Z" }),
        job({ id: "exactly-now", resetAt: "2026-07-30T10:00:00.000Z" }),
        job({ id: "future", resetAt: "2026-07-30T11:00:00.000Z" }),
      ],
      NOW
    );
    // totalWaiting counts all three; only past + exactly-now are overdue.
    expect(report.totalWaiting).toBe(3);
    expect(report.entries.map((e) => e.job.id).sort()).toEqual(["exactly-now", "past"]);
    expect(report.overdueCount).toBe(2);
  });

  it("orders entries most-overdue first and numbers positions from 1", () => {
    const report = buildOverdueReport(
      [
        job({ id: "recent", resetAt: "2026-07-30T09:50:00.000Z" }),
        job({ id: "ancient", resetAt: "2026-07-30T06:00:00.000Z" }),
        job({ id: "mid", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["ancient", "mid", "recent"]);
    expect(report.entries.map((e) => e.position)).toEqual([1, 2, 3]);
    expect(report.worstOverdueMs).toBe(4 * 60 * 60 * 1000);
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
    // Same reset → oldest createdAt first (c), then id order (a before b).
    expect(report.entries.map((e) => e.job.id)).toEqual(["c", "a", "b"]);
  });

  it("computes overdueByMs against now", () => {
    const report = buildOverdueReport([job({ id: "j", resetAt: "2026-07-30T08:30:00.000Z" })], NOW);
    expect(report.entries[0]?.overdueByMs).toBe(90 * 60 * 1000);
  });

  it("flags jobs past the grace window as concerning, sparing freshly-due ones", () => {
    const report = buildOverdueReport(
      [
        job({ id: "fresh", resetAt: "2026-07-30T09:59:30.000Z" }), // 30s overdue
        job({ id: "stuck", resetAt: "2026-07-30T09:00:00.000Z" }), // 1h overdue
      ],
      NOW,
      { graceMs: DEFAULT_OVERDUE_GRACE_MS }
    );
    const fresh = report.entries.find((e) => e.job.id === "fresh");
    const stuck = report.entries.find((e) => e.job.id === "stuck");
    expect(fresh?.concerning).toBe(false);
    expect(stuck?.concerning).toBe(true);
    expect(report.overdueCount).toBe(2);
    expect(report.concerningCount).toBe(1);
  });

  it("treats a non-positive or non-finite grace as zero (everything overdue is concerning)", () => {
    const jobs = [job({ id: "j", resetAt: "2026-07-30T09:59:59.000Z" })]; // 1s overdue
    expect(buildOverdueReport(jobs, NOW, { graceMs: 0 }).concerningCount).toBe(1);
    expect(buildOverdueReport(jobs, NOW, { graceMs: -5 }).concerningCount).toBe(1);
    expect(buildOverdueReport(jobs, NOW, { graceMs: Number.NaN }).concerningCount).toBe(1);
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
    expect(report.overdueCount).toBe(4);
    expect(report.hidden).toBe(2);
  });

  it("ignores a non-integer limit and shows everything", () => {
    const jobs = [
      job({ id: "j1", resetAt: "2026-07-30T06:00:00.000Z" }),
      job({ id: "j2", resetAt: "2026-07-30T07:00:00.000Z" }),
    ];
    expect(buildOverdueReport(jobs, NOW, { limit: 1.5 }).entries).toHaveLength(2);
    expect(buildOverdueReport(jobs, NOW, { limit: 0 }).entries).toHaveLength(0);
    expect(buildOverdueReport(jobs, NOW).entries).toHaveLength(2);
  });

  it("does not mutate the input array order", () => {
    const jobs = [
      job({ id: "recent", resetAt: "2026-07-30T09:50:00.000Z" }),
      job({ id: "ancient", resetAt: "2026-07-30T06:00:00.000Z" }),
    ];
    buildOverdueReport(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(["recent", "ancient"]);
  });
});
