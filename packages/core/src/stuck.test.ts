import { describe, expect, it } from "vitest";
import { buildStuckReport } from "./stuck.js";
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
    status: "resuming",
    resetAt: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T09:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-30T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describe("buildStuckReport", () => {
  it("returns an empty report when nothing is resuming", () => {
    const report = buildStuckReport([], NOW);
    expect(report).toEqual({ entries: [], totalStuck: 0, hidden: 0, graceMs: 0, maxStuckForMs: 0 });
  });

  it("ignores jobs that are not resuming even if their updatedAt is old", () => {
    const report = buildStuckReport(
      [
        job({ status: "completed", updatedAt: "2026-07-30T06:00:00.000Z" }),
        job({ status: "queued", updatedAt: "2026-07-30T06:00:00.000Z" }),
        job({ status: "waiting_for_reset", updatedAt: "2026-07-30T06:00:00.000Z" }),
        job({ status: "failed", updatedAt: "2026-07-30T06:00:00.000Z" }),
        job({ status: "cancelled", updatedAt: "2026-07-30T06:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.totalStuck).toBe(0);
  });

  it("skips resuming jobs with a missing or unparseable updatedAt", () => {
    const report = buildStuckReport(
      [job({ id: "bad", updatedAt: "not a date" }), job({ id: "good", updatedAt: "2026-07-30T08:00:00.000Z" })],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["good"]);
  });

  it("ranks the longest-stuck job first and computes stuckForMs", () => {
    const report = buildStuckReport(
      [
        job({ id: "recent", updatedAt: "2026-07-30T09:30:00.000Z" }),
        job({ id: "ancient", updatedAt: "2026-07-30T06:00:00.000Z" }),
        job({ id: "mid", updatedAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["ancient", "mid", "recent"]);
    expect(report.entries[0].stuckForMs).toBe(4 * HOUR);
    expect(report.maxStuckForMs).toBe(4 * HOUR);
  });

  it("breaks ties deterministically by createdAt then id", () => {
    const report = buildStuckReport(
      [
        job({ id: "b", updatedAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "a", updatedAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "c", updatedAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
      ],
      NOW
    );
    // Same updatedAt → oldest createdAt first (c), then id order (a before b).
    expect(report.entries.map((e) => e.job.id)).toEqual(["c", "a", "b"]);
  });

  it("honors the grace window so freshly-started resumes are not flagged", () => {
    const jobs = [
      job({ id: "just-started", updatedAt: "2026-07-30T09:59:30.000Z" }), // 30s ago
      job({ id: "long-stuck", updatedAt: "2026-07-30T08:00:00.000Z" }), // 2h ago
    ];
    const report = buildStuckReport(jobs, NOW, { graceMs: 60 * 1000 });
    expect(report.entries.map((e) => e.job.id)).toEqual(["long-stuck"]);
    expect(report.graceMs).toBe(60 * 1000);
  });

  it("treats the grace as strict (a job stuck for exactly graceMs is not flagged)", () => {
    const jobs = [job({ id: "edge", updatedAt: "2026-07-30T09:00:00.000Z" })]; // exactly 1h ago
    expect(buildStuckReport(jobs, NOW, { graceMs: HOUR }).totalStuck).toBe(0);
    expect(buildStuckReport(jobs, NOW, { graceMs: HOUR - 1 }).totalStuck).toBe(1);
  });

  it("treats a negative or non-finite grace as zero", () => {
    const jobs = [job({ id: "one-ms-stuck", updatedAt: "2026-07-30T09:59:59.999Z" })];
    expect(buildStuckReport(jobs, NOW, { graceMs: -5000 }).graceMs).toBe(0);
    expect(buildStuckReport(jobs, NOW, { graceMs: Number.NaN }).graceMs).toBe(0);
    expect(buildStuckReport(jobs, NOW, { graceMs: -5000 }).totalStuck).toBe(1);
  });

  it("trims to the limit while keeping totals and maxStuckForMs honest", () => {
    const report = buildStuckReport(
      [
        job({ id: "j1", updatedAt: "2026-07-30T06:00:00.000Z" }),
        job({ id: "j2", updatedAt: "2026-07-30T07:00:00.000Z" }),
        job({ id: "j3", updatedAt: "2026-07-30T08:00:00.000Z" }),
        job({ id: "j4", updatedAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW,
      { limit: 2 }
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["j1", "j2"]);
    expect(report.totalStuck).toBe(4);
    expect(report.hidden).toBe(2);
    expect(report.maxStuckForMs).toBe(4 * HOUR);
  });

  it("ignores a non-positive or non-integer limit and shows everything", () => {
    const jobs = [
      job({ id: "j1", updatedAt: "2026-07-30T08:00:00.000Z" }),
      job({ id: "j2", updatedAt: "2026-07-30T09:00:00.000Z" }),
    ];
    expect(buildStuckReport(jobs, NOW, { limit: 0 }).entries).toHaveLength(0);
    expect(buildStuckReport(jobs, NOW, { limit: 1.5 }).entries).toHaveLength(2);
    expect(buildStuckReport(jobs, NOW, {}).entries).toHaveLength(2);
  });

  it("does not mutate the input array order", () => {
    const jobs = [
      job({ id: "recent", updatedAt: "2026-07-30T09:30:00.000Z" }),
      job({ id: "ancient", updatedAt: "2026-07-30T06:00:00.000Z" }),
    ];
    buildStuckReport(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(["recent", "ancient"]);
  });
});
