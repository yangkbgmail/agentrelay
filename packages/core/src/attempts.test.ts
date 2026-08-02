import { describe, expect, it } from "vitest";
import { buildAttemptReport } from "./attempts.js";
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

describe("buildAttemptReport", () => {
  it("returns an empty report for no jobs", () => {
    const report = buildAttemptReport([]);
    expect(report).toEqual({
      entries: [],
      totalJobs: 0,
      withAttempts: 0,
      totalAttempts: 0,
      maxAttempts: 0,
      riskThreshold: 1,
      atRiskCount: 0,
      hidden: 0,
      maxSingleAttempts: 0,
    });
  });

  it("excludes never-retried jobs from entries but still counts them in totalJobs", () => {
    const report = buildAttemptReport([job({ attempts: 0 }), job({ attempts: 0 }), job({ attempts: 2 })]);
    expect(report.totalJobs).toBe(3);
    expect(report.withAttempts).toBe(1);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].attempts).toBe(2);
    expect(report.totalAttempts).toBe(2);
    expect(report.maxSingleAttempts).toBe(2);
  });

  it("ranks jobs most-attempted first", () => {
    const report = buildAttemptReport([
      job({ id: "low", attempts: 1 }),
      job({ id: "high", attempts: 5 }),
      job({ id: "mid", attempts: 3 }),
    ]);
    expect(report.entries.map((e) => e.job.id)).toEqual(["high", "mid", "low"]);
  });

  it("computes remaining against a finite budget and leaves it null when unlimited", () => {
    const finite = buildAttemptReport([job({ attempts: 3 })], { maxAttempts: 5 });
    expect(finite.entries[0].remaining).toBe(2);
    expect(finite.maxAttempts).toBe(5);

    const unlimited = buildAttemptReport([job({ attempts: 9 })], { maxAttempts: 0 });
    expect(unlimited.entries[0].remaining).toBeNull();
    expect(unlimited.entries[0].atRisk).toBe(false);
  });

  it("floors remaining at zero when a non-terminal job has already met/exceeded the budget", () => {
    const report = buildAttemptReport([job({ attempts: 7, status: "waiting_for_reset" })], { maxAttempts: 5 });
    expect(report.entries[0].remaining).toBe(0);
    expect(report.entries[0].atRisk).toBe(true);
  });

  it("flags a non-terminal job at risk once remaining hits the threshold, but not a terminal one", () => {
    const report = buildAttemptReport(
      [
        job({ id: "live", status: "waiting_for_reset", attempts: 4 }),
        job({ id: "done", status: "completed", attempts: 4 }),
        job({ id: "safe", status: "queued", attempts: 2 }),
      ],
      { maxAttempts: 5 }
    );
    const byId = Object.fromEntries(report.entries.map((e) => [e.job.id, e]));
    expect(byId.live.atRisk).toBe(true); // remaining 1
    expect(byId.done.atRisk).toBe(false); // terminal, never at risk
    expect(byId.safe.atRisk).toBe(false); // remaining 3 > threshold 1
    expect(report.atRiskCount).toBe(1);
  });

  it("respects a custom risk threshold", () => {
    const report = buildAttemptReport([job({ status: "queued", attempts: 2 })], { maxAttempts: 5, riskThreshold: 3 });
    // remaining = 3, threshold = 3 → at risk
    expect(report.entries[0].atRisk).toBe(true);
  });

  it("clamps a negative/non-finite risk threshold to zero (never warns)", () => {
    const report = buildAttemptReport([job({ status: "queued", attempts: 4 })], { maxAttempts: 5, riskThreshold: -2 });
    // remaining = 1, threshold clamped to 0 → not at risk
    expect(report.entries[0].atRisk).toBe(false);
  });

  it("breaks attempt ties toward the live/at-risk job, then oldest createdAt, then id", () => {
    const report = buildAttemptReport(
      [
        job({ id: "done-early", status: "completed", attempts: 4, createdAt: "2026-07-30T01:00:00.000Z" }),
        job({ id: "live-late", status: "waiting_for_reset", attempts: 4, createdAt: "2026-07-30T05:00:00.000Z" }),
        job({ id: "live-early", status: "queued", attempts: 4, createdAt: "2026-07-30T02:00:00.000Z" }),
      ],
      { maxAttempts: 5 }
    );
    // All three tie on attempts (4). The two non-terminal ones are at risk
    // (remaining 1) and sort ahead of the terminal one; between them, oldest
    // createdAt wins: live-early (02:00) before live-late (05:00). Terminal last.
    expect(report.entries.map((e) => e.job.id)).toEqual(["live-early", "live-late", "done-early"]);
  });

  it("trims entries to limit while totals reflect the full set", () => {
    const report = buildAttemptReport([job({ attempts: 5 }), job({ attempts: 4 }), job({ attempts: 3 })], { limit: 2 });
    expect(report.entries).toHaveLength(2);
    expect(report.entries.map((e) => e.attempts)).toEqual([5, 4]);
    expect(report.withAttempts).toBe(3);
    expect(report.hidden).toBe(1);
    expect(report.totalAttempts).toBe(12);
    expect(report.maxSingleAttempts).toBe(5);
  });

  it("does not mutate the input array", () => {
    const jobs = [job({ attempts: 1 }), job({ attempts: 9 })];
    const before = jobs.map((j) => j.id);
    buildAttemptReport(jobs, { maxAttempts: 5, limit: 1 });
    expect(jobs.map((j) => j.id)).toEqual(before);
  });
});
