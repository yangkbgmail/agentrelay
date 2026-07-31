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
    expect(report).toEqual({ entries: [], total: 0, hidden: 0, maxOverdueMs: 0, thresholdMs: 0 });
  });

  it("ignores jobs that are not waiting_for_reset even if their resetAt is in the past", () => {
    const report = buildOverdueReport(
      [
        job({ status: "completed", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "queued", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "resuming", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "failed", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.total).toBe(0);
    expect(report.entries).toHaveLength(0);
  });

  it("ignores waiting jobs whose reset time is still in the future", () => {
    const report = buildOverdueReport(
      [
        job({ id: "future", resetAt: "2026-07-30T11:00:00.000Z" }),
        job({ id: "past", resetAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["past"]);
    expect(report.total).toBe(1);
  });

  it("treats a reset exactly at now as overdue (0 threshold, boundary)", () => {
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T10:00:00.000Z" })], NOW);
    expect(report.total).toBe(1);
    expect(report.entries[0].overdueMs).toBe(0);
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

  it("orders most-overdue first and numbers positions from 1", () => {
    const report = buildOverdueReport(
      [
        job({ id: "recent", resetAt: "2026-07-30T09:30:00.000Z" }),
        job({ id: "oldest", resetAt: "2026-07-30T06:00:00.000Z" }),
        job({ id: "mid", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["oldest", "mid", "recent"]);
    expect(report.entries.map((e) => e.position)).toEqual([1, 2, 3]);
    // oldest reset (06:00) is 4h past 10:00.
    expect(report.entries[0].overdueMs).toBe(4 * HOUR);
    expect(report.maxOverdueMs).toBe(4 * HOUR);
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

  it("applies the thresholdMs filter (only jobs overdue by at least the threshold)", () => {
    const report = buildOverdueReport(
      [
        job({ id: "barely", resetAt: "2026-07-30T09:58:00.000Z" }), // 2m overdue
        job({ id: "stuck", resetAt: "2026-07-30T09:00:00.000Z" }), // 1h overdue
      ],
      NOW,
      { thresholdMs: 30 * 60 * 1000 } // 30m
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["stuck"]);
    expect(report.total).toBe(1);
    expect(report.thresholdMs).toBe(30 * 60 * 1000);
  });

  it("treats a job overdue exactly at the threshold as included (>=)", () => {
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T09:00:00.000Z" })], NOW, { thresholdMs: HOUR });
    expect(report.total).toBe(1);
  });

  it("clamps a negative or non-finite threshold to 0 (every past-due job)", () => {
    const jobs = [job({ resetAt: "2026-07-30T09:59:00.000Z" })]; // 1m overdue
    expect(buildOverdueReport(jobs, NOW, { thresholdMs: -5000 }).total).toBe(1);
    expect(buildOverdueReport(jobs, NOW, { thresholdMs: Number.NaN }).total).toBe(1);
    expect(buildOverdueReport(jobs, NOW, { thresholdMs: -5000 }).thresholdMs).toBe(0);
  });

  it("trims to the limit while keeping totals and maxOverdueMs honest", () => {
    const report = buildOverdueReport(
      [
        job({ id: "j1", resetAt: "2026-07-30T06:00:00.000Z" }), // 4h — worst
        job({ id: "j2", resetAt: "2026-07-30T07:00:00.000Z" }),
        job({ id: "j3", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ id: "j4", resetAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW,
      { limit: 2 }
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["j1", "j2"]);
    expect(report.total).toBe(4);
    expect(report.hidden).toBe(2);
    expect(report.maxOverdueMs).toBe(4 * HOUR);
  });

  it("ignores a non-positive or non-integer limit and shows everything", () => {
    const jobs = [
      job({ id: "j1", resetAt: "2026-07-30T08:00:00.000Z" }),
      job({ id: "j2", resetAt: "2026-07-30T09:00:00.000Z" }),
    ];
    expect(buildOverdueReport(jobs, NOW, { limit: 0 }).entries).toHaveLength(0);
    expect(buildOverdueReport(jobs, NOW, { limit: 1.5 }).entries).toHaveLength(2);
    expect(buildOverdueReport(jobs, NOW, {}).entries).toHaveLength(2);
  });

  it("does not mutate the input array order", () => {
    const jobs = [
      job({ id: "recent", resetAt: "2026-07-30T09:30:00.000Z" }),
      job({ id: "oldest", resetAt: "2026-07-30T06:00:00.000Z" }),
    ];
    buildOverdueReport(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(["recent", "oldest"]);
  });
});
