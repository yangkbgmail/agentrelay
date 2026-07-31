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
    resetAt: "2026-07-30T08:00:00.000Z",
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
  it("returns an empty report when nothing is overdue", () => {
    const report = findOverdueJobs([], NOW);
    expect(report).toEqual({
      entries: [],
      totalOverdue: 0,
      hidden: 0,
      maxOverdueByMs: 0,
      graceMs: DEFAULT_OVERDUE_GRACE_MS,
    });
  });

  it("ignores jobs that are not waiting_for_reset even if their reset is long past", () => {
    const report = findOverdueJobs(
      [
        job({ status: "completed", resetAt: "2026-07-30T01:00:00.000Z" }),
        job({ status: "queued", resetAt: "2026-07-30T01:00:00.000Z" }),
        job({ status: "resuming", resetAt: "2026-07-30T01:00:00.000Z" }),
        job({ status: "failed", resetAt: "2026-07-30T01:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.totalOverdue).toBe(0);
  });

  it("ignores waiting jobs with a missing or unparseable resetAt", () => {
    const report = findOverdueJobs(
      [
        job({ id: "no-reset", resetAt: null }),
        job({ id: "bad-reset", resetAt: "not a date" }),
        job({ id: "stuck", resetAt: "2026-07-30T01:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["stuck"]);
  });

  it("only flags jobs past the grace window", () => {
    const report = findOverdueJobs(
      [
        // 30s past reset → inside default 90s grace → not overdue.
        job({ id: "fresh", resetAt: "2026-07-30T09:59:30.000Z" }),
        // 2h past reset → well past grace → overdue.
        job({ id: "stale", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["stale"]);
    expect(report.totalOverdue).toBe(1);
  });

  it("treats a reset exactly at the grace boundary as not overdue (strict >)", () => {
    const report = findOverdueJobs([job({ resetAt: "2026-07-30T09:58:30.000Z" })], NOW); // exactly 90s past
    expect(report.totalOverdue).toBe(0);
  });

  it("does not flag future or not-yet-due resets", () => {
    const report = findOverdueJobs(
      [
        job({ id: "future", resetAt: "2026-07-30T12:00:00.000Z" }),
        job({ id: "now", resetAt: "2026-07-30T10:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.totalOverdue).toBe(0);
  });

  it("orders entries worst-first and numbers positions from 1", () => {
    const report = findOverdueJobs(
      [
        job({ id: "mild", resetAt: "2026-07-30T09:00:00.000Z" }), // 1h
        job({ id: "worst", resetAt: "2026-07-30T06:00:00.000Z" }), // 4h
        job({ id: "mid", resetAt: "2026-07-30T08:00:00.000Z" }), // 2h
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["worst", "mid", "mild"]);
    expect(report.entries.map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it("computes overdueByMs and maxOverdueByMs against now", () => {
    const report = findOverdueJobs(
      [
        job({ id: "a", resetAt: "2026-07-30T09:00:00.000Z" }), // 1h
        job({ id: "b", resetAt: "2026-07-30T07:00:00.000Z" }), // 3h
      ],
      NOW
    );
    const a = report.entries.find((e) => e.job.id === "a");
    const b = report.entries.find((e) => e.job.id === "b");
    expect(a?.overdueByMs).toBe(60 * 60 * 1000);
    expect(b?.overdueByMs).toBe(3 * 60 * 60 * 1000);
    expect(report.maxOverdueByMs).toBe(3 * 60 * 60 * 1000);
  });

  it("breaks ties deterministically by createdAt then id", () => {
    const report = findOverdueJobs(
      [
        job({ id: "b", resetAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "a", resetAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "c", resetAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["c", "a", "b"]);
  });

  it("honors a custom grace window", () => {
    const jobs = [job({ id: "j", resetAt: "2026-07-30T09:55:00.000Z" })]; // 5m past
    expect(findOverdueJobs(jobs, NOW, { graceMs: 10 * 60 * 1000 }).totalOverdue).toBe(0); // 10m grace
    expect(findOverdueJobs(jobs, NOW, { graceMs: 60 * 1000 }).totalOverdue).toBe(1); // 1m grace
  });

  it("clamps a negative grace to the default rather than flagging everything", () => {
    const report = findOverdueJobs([job({ resetAt: "2026-07-30T09:59:45.000Z" })], NOW, { graceMs: -5000 });
    expect(report.graceMs).toBe(DEFAULT_OVERDUE_GRACE_MS);
    expect(report.totalOverdue).toBe(0);
  });

  it("accepts a zero grace (any past-due job counts)", () => {
    const report = findOverdueJobs([job({ resetAt: "2026-07-30T09:59:59.000Z" })], NOW, { graceMs: 0 });
    expect(report.graceMs).toBe(0);
    expect(report.totalOverdue).toBe(1);
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
    expect(report.maxOverdueByMs).toBe(4 * 60 * 60 * 1000); // still the worst, not the shown max
  });

  it("ignores a non-positive or non-integer limit and shows everything", () => {
    const jobs = [
      job({ id: "j1", resetAt: "2026-07-30T06:00:00.000Z" }),
      job({ id: "j2", resetAt: "2026-07-30T07:00:00.000Z" }),
    ];
    expect(findOverdueJobs(jobs, NOW, { limit: 0 }).entries).toHaveLength(0);
    expect(findOverdueJobs(jobs, NOW, { limit: 1.5 }).entries).toHaveLength(2);
  });

  it("does not mutate the input array order", () => {
    const jobs = [
      job({ id: "mild", resetAt: "2026-07-30T09:00:00.000Z" }),
      job({ id: "worst", resetAt: "2026-07-30T06:00:00.000Z" }),
    ];
    findOverdueJobs(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(["mild", "worst"]);
  });
});
