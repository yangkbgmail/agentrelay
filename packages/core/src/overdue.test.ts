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
    expect(report).toEqual({ entries: [], totalOverdue: 0, hidden: 0, graceMs: 0, worstOverdueMs: null });
  });

  it("ignores jobs that are not waiting_for_reset even if their reset passed", () => {
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
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T11:00:00.000Z" })], NOW);
    expect(report.totalOverdue).toBe(0);
  });

  it("does not flag a job whose reset is exactly now (not strictly past)", () => {
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

  it("ranks the most-overdue (earliest reset) job first and numbers positions", () => {
    const report = buildOverdueReport(
      [
        job({ id: "recent", resetAt: "2026-07-30T09:30:00.000Z" }),
        job({ id: "ancient", resetAt: "2026-07-30T06:00:00.000Z" }),
        job({ id: "mid", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["ancient", "mid", "recent"]);
    expect(report.entries.map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it("computes overdueMs and reports the worst case", () => {
    const report = buildOverdueReport(
      [
        job({ id: "a", resetAt: "2026-07-30T09:00:00.000Z" }), // 1h overdue
        job({ id: "b", resetAt: "2026-07-30T07:00:00.000Z" }), // 3h overdue
      ],
      NOW
    );
    expect(report.entries.find((e) => e.job.id === "b")?.overdueMs).toBe(3 * 60 * 60 * 1000);
    expect(report.entries.find((e) => e.job.id === "a")?.overdueMs).toBe(60 * 60 * 1000);
    expect(report.worstOverdueMs).toBe(3 * 60 * 60 * 1000);
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

  it("applies a grace period so barely-late jobs are not flagged", () => {
    const jobs = [
      job({ id: "barely", resetAt: "2026-07-30T09:59:00.000Z" }), // 1m overdue
      job({ id: "stuck", resetAt: "2026-07-30T09:00:00.000Z" }), // 1h overdue
    ];
    const report = buildOverdueReport(jobs, NOW, { graceMs: 5 * 60 * 1000 });
    expect(report.entries.map((e) => e.job.id)).toEqual(["stuck"]);
    expect(report.totalOverdue).toBe(1);
    expect(report.graceMs).toBe(5 * 60 * 1000);
  });

  it("treats a non-positive grace as no grace (any strictly past-due job)", () => {
    const jobs = [job({ resetAt: "2026-07-30T09:59:59.000Z" })];
    expect(buildOverdueReport(jobs, NOW, { graceMs: 0 }).totalOverdue).toBe(1);
    expect(buildOverdueReport(jobs, NOW, { graceMs: -5 }).totalOverdue).toBe(1);
    expect(buildOverdueReport(jobs, NOW, { graceMs: -5 }).graceMs).toBe(0);
  });

  it("trims to the limit while keeping totals and worst honest", () => {
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
    expect(report.worstOverdueMs).toBe(4 * 60 * 60 * 1000);
  });

  it("ignores a non-positive or non-integer limit and shows everything", () => {
    const jobs = [
      job({ id: "j1", resetAt: "2026-07-30T07:00:00.000Z" }),
      job({ id: "j2", resetAt: "2026-07-30T08:00:00.000Z" }),
    ];
    expect(buildOverdueReport(jobs, NOW, { limit: 0 }).entries).toHaveLength(0);
    expect(buildOverdueReport(jobs, NOW, { limit: 1.5 }).entries).toHaveLength(2);
    expect(buildOverdueReport(jobs, NOW, {}).entries).toHaveLength(2);
  });

  it("does not mutate the input array order", () => {
    const jobs = [
      job({ id: "recent", resetAt: "2026-07-30T09:30:00.000Z" }),
      job({ id: "ancient", resetAt: "2026-07-30T06:00:00.000Z" }),
    ];
    buildOverdueReport(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(["recent", "ancient"]);
  });
});
