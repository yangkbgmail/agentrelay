import { describe, expect, it } from "vitest";
import { computeOverdue } from "./overdue.js";
import type { AgentTool, JobStatus, RelayJob } from "./types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "proj",
    tool: "claude-code" as AgentTool,
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "waiting_for_reset" as JobStatus,
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
/** ISO string for `NOW + minutes`. */
function iso(minutesFromNow: number): string {
  return new Date(NOW + minutesFromNow * 60_000).toISOString();
}

describe("computeOverdue", () => {
  it("returns an empty report for an empty store", () => {
    const report = computeOverdue([], { now: NOW });
    expect(report).toEqual({ totalWaiting: 0, overdueCount: 0, graceMs: 0, jobs: [] });
  });

  it("flags a waiting job whose reset time has passed", () => {
    const jobs = [job({ resetAt: iso(-30) })]; // reset was 30m ago
    const report = computeOverdue(jobs, { now: NOW });
    expect(report.totalWaiting).toBe(1);
    expect(report.overdueCount).toBe(1);
    expect(report.jobs[0].overdueMs).toBe(30 * 60_000);
  });

  it("does not flag a waiting job whose reset is still in the future", () => {
    const jobs = [job({ resetAt: iso(30) })]; // reset in 30m
    const report = computeOverdue(jobs, { now: NOW });
    expect(report.totalWaiting).toBe(1);
    expect(report.overdueCount).toBe(0);
    expect(report.jobs).toEqual([]);
  });

  it("only counts waiting_for_reset jobs, not active or terminal ones", () => {
    const jobs = [
      job({ status: "waiting_for_reset", resetAt: iso(-10) }), // overdue
      job({ status: "resuming", resetAt: iso(-10) }), // mid-flight, excluded
      job({ status: "queued", resetAt: iso(-10) }), // no real reset, excluded
      job({ status: "completed", resetAt: iso(-10) }), // done, excluded
      job({ status: "failed", resetAt: iso(-10) }), // done, excluded
      job({ status: "cancelled", resetAt: iso(-10) }), // done, excluded
    ];
    const report = computeOverdue(jobs, { now: NOW });
    expect(report.totalWaiting).toBe(1);
    expect(report.overdueCount).toBe(1);
  });

  it("excludes jobs with a null or unparseable resetAt", () => {
    const jobs = [
      job({ resetAt: null }),
      job({ resetAt: "not-a-date" }),
      job({ resetAt: iso(-5) }), // the only valid overdue one
    ];
    const report = computeOverdue(jobs, { now: NOW });
    expect(report.totalWaiting).toBe(1);
    expect(report.overdueCount).toBe(1);
  });

  it("respects the grace window: within grace is not overdue, beyond it is", () => {
    const jobs = [
      job({ id: "within", resetAt: iso(-1) }), // 1m past due
      job({ id: "beyond", resetAt: iso(-10) }), // 10m past due
    ];
    const report = computeOverdue(jobs, { now: NOW, graceMs: 5 * 60_000 });
    expect(report.totalWaiting).toBe(2);
    expect(report.overdueCount).toBe(1);
    expect(report.graceMs).toBe(5 * 60_000);
    expect(report.jobs[0].job.id).toBe("beyond");
  });

  it("a job exactly at the grace boundary is not overdue (strictly greater than grace)", () => {
    const jobs = [job({ resetAt: iso(-5) })]; // exactly 5m past due
    const report = computeOverdue(jobs, { now: NOW, graceMs: 5 * 60_000 });
    expect(report.overdueCount).toBe(0);
  });

  it("ranks the most-overdue job first", () => {
    const jobs = [
      job({ id: "a", resetAt: iso(-10) }),
      job({ id: "b", resetAt: iso(-60) }), // latest
      job({ id: "c", resetAt: iso(-30) }),
    ];
    const report = computeOverdue(jobs, { now: NOW });
    expect(report.jobs.map((entry) => entry.job.id)).toEqual(["b", "c", "a"]);
  });

  it("breaks ties on equal lateness by createdAt then id (deterministic)", () => {
    const jobs = [
      job({ id: "z", resetAt: iso(-10), createdAt: "2026-07-13T00:00:00.000Z" }),
      job({ id: "a", resetAt: iso(-10), createdAt: "2026-07-13T00:00:00.000Z" }),
      job({ id: "m", resetAt: iso(-10), createdAt: "2026-07-12T00:00:00.000Z" }), // oldest → first
    ];
    const report = computeOverdue(jobs, { now: NOW });
    expect(report.jobs.map((entry) => entry.job.id)).toEqual(["m", "a", "z"]);
  });

  it("treats a non-positive grace as no grace", () => {
    const jobs = [job({ resetAt: iso(-1) })];
    expect(computeOverdue(jobs, { now: NOW, graceMs: 0 }).overdueCount).toBe(1);
    expect(computeOverdue(jobs, { now: NOW, graceMs: -100 }).overdueCount).toBe(1);
  });

  it("does not mutate the input job list", () => {
    const jobs = [job({ resetAt: iso(-10) }), job({ resetAt: iso(-5) })];
    const snapshot = [...jobs];
    computeOverdue(jobs, { now: NOW });
    expect(jobs).toEqual(snapshot);
  });
});
