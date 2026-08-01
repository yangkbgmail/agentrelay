import { describe, expect, it } from "vitest";
import { DEFAULT_OVERDUE_GRACE_MS, findOverdueJobs } from "./overdue.js";
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

describe("findOverdueJobs", () => {
  it("returns an empty report when nothing is waiting", () => {
    const report = findOverdueJobs([], NOW);
    expect(report).toEqual({
      entries: [],
      totalOverdue: 0,
      hidden: 0,
      worstOverdueMs: 0,
      graceMs: DEFAULT_OVERDUE_GRACE_MS,
    });
  });

  it("ignores jobs that are not waiting_for_reset even if their reset has passed", () => {
    const report = findOverdueJobs(
      [job({ status: "completed" }), job({ status: "queued" }), job({ status: "resuming" }), job({ status: "failed" })],
      NOW
    );
    expect(report.totalOverdue).toBe(0);
    expect(report.entries).toHaveLength(0);
  });

  it("ignores waiting jobs with a missing or unparseable resetAt", () => {
    const report = findOverdueJobs(
      [job({ id: "no-reset", resetAt: null }), job({ id: "bad-reset", resetAt: "not a date" })],
      NOW
    );
    expect(report.totalOverdue).toBe(0);
  });

  it("does not flag jobs whose reset is in the future", () => {
    const report = findOverdueJobs([job({ resetAt: "2026-07-30T11:00:00.000Z" })], NOW);
    expect(report.totalOverdue).toBe(0);
  });

  it("does not flag a job past due but still inside the grace period", () => {
    // 30s past reset, default grace is 60s → not yet overdue.
    const report = findOverdueJobs([job({ resetAt: "2026-07-30T09:59:30.000Z" })], NOW);
    expect(report.totalOverdue).toBe(0);
  });

  it("flags a job once it is past due beyond the grace period", () => {
    // 90s past reset, default grace 60s → overdue by 90s.
    const report = findOverdueJobs([job({ id: "stuck", resetAt: "2026-07-30T09:58:30.000Z" })], NOW);
    expect(report.totalOverdue).toBe(1);
    expect(report.entries[0]?.job.id).toBe("stuck");
    expect(report.entries[0]?.overdueByMs).toBe(90 * 1000);
    expect(report.worstOverdueMs).toBe(90 * 1000);
  });

  it("treats the grace boundary as exclusive (exactly graceMs past due is not overdue)", () => {
    // Exactly 60s past reset with a 60s grace → now - reset === grace, not > grace.
    const report = findOverdueJobs([job({ resetAt: "2026-07-30T09:59:00.000Z" })], NOW, { graceMs: 60_000 });
    expect(report.totalOverdue).toBe(0);
  });

  it("honors a custom grace period", () => {
    const jobs = [job({ id: "a", resetAt: "2026-07-30T09:55:00.000Z" })]; // 5m past due
    expect(findOverdueJobs(jobs, NOW, { graceMs: 10 * 60 * 1000 }).totalOverdue).toBe(0);
    expect(findOverdueJobs(jobs, NOW, { graceMs: 60 * 1000 }).totalOverdue).toBe(1);
  });

  it("clamps a negative grace to zero", () => {
    // 1ms past due with a negative grace → overdue (0 grace, exclusive boundary).
    const report = findOverdueJobs([job({ resetAt: "2026-07-30T09:59:59.999Z" })], NOW, { graceMs: -5000 });
    expect(report.graceMs).toBe(0);
    expect(report.totalOverdue).toBe(1);
  });

  it("orders entries most-overdue first and numbers positions from 1", () => {
    const report = findOverdueJobs(
      [
        job({ id: "recent", resetAt: "2026-07-30T09:57:00.000Z" }), // 3m
        job({ id: "worst", resetAt: "2026-07-30T08:00:00.000Z" }), // 2h
        job({ id: "mid", resetAt: "2026-07-30T09:00:00.000Z" }), // 1h
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["worst", "mid", "recent"]);
    expect(report.entries.map((e) => e.position)).toEqual([1, 2, 3]);
    expect(report.worstOverdueMs).toBe(2 * 60 * 60 * 1000);
  });

  it("breaks ties deterministically by createdAt then id", () => {
    const report = findOverdueJobs(
      [
        job({ id: "b", resetAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "a", resetAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "c", resetAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
      ],
      NOW
    );
    // Same reset → oldest createdAt first (c), then id order (a before b).
    expect(report.entries.map((e) => e.job.id)).toEqual(["c", "a", "b"]);
  });

  it("trims to the limit while keeping totals honest", () => {
    const report = findOverdueJobs(
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
    // worst reflects the full set (j1 at 4h), not just the shown rows.
    expect(report.worstOverdueMs).toBe(4 * 60 * 60 * 1000);
  });

  it("ignores a non-positive or non-integer limit and shows everything", () => {
    const jobs = [
      job({ id: "j1", resetAt: "2026-07-30T08:00:00.000Z" }),
      job({ id: "j2", resetAt: "2026-07-30T09:00:00.000Z" }),
    ];
    expect(findOverdueJobs(jobs, NOW, { limit: 0 }).entries).toHaveLength(0);
    expect(findOverdueJobs(jobs, NOW, { limit: 1.5 }).entries).toHaveLength(2);
    expect(findOverdueJobs(jobs, NOW, {}).entries).toHaveLength(2);
  });

  it("does not mutate the input array order", () => {
    const jobs = [
      job({ id: "recent", resetAt: "2026-07-30T09:57:00.000Z" }),
      job({ id: "worst", resetAt: "2026-07-30T08:00:00.000Z" }),
    ];
    findOverdueJobs(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(["recent", "worst"]);
  });
});
