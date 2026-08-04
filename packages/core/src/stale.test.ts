import { describe, expect, it } from "vitest";
import { buildStaleReport } from "./stale.js";
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

describe("buildStaleReport", () => {
  it("returns an empty report when nothing is stale", () => {
    const report = buildStaleReport([], NOW);
    expect(report).toEqual({ entries: [], totalStale: 0, hidden: 0, thresholdMs: 0, maxStuckForMs: 0 });
  });

  it("ignores jobs that are not resuming even if their updatedAt is old", () => {
    const report = buildStaleReport(
      [
        job({ status: "completed", updatedAt: "2026-07-30T06:00:00.000Z" }),
        job({ status: "queued", updatedAt: "2026-07-30T06:00:00.000Z" }),
        job({ status: "waiting_for_reset", updatedAt: "2026-07-30T06:00:00.000Z" }),
        job({ status: "failed", updatedAt: "2026-07-30T06:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.totalStale).toBe(0);
  });

  it("ignores resuming jobs with an unparseable updatedAt", () => {
    const report = buildStaleReport(
      [job({ id: "bad", updatedAt: "not a date" }), job({ id: "good", updatedAt: "2026-07-30T08:00:00.000Z" })],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["good"]);
  });

  it("ranks the longest-stuck job first and computes stuckForMs", () => {
    const report = buildStaleReport(
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
    const report = buildStaleReport(
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

  it("honors the threshold so freshly-resuming jobs are not flagged", () => {
    const jobs = [
      job({ id: "just-started", updatedAt: "2026-07-30T09:59:30.000Z" }), // 30s ago
      job({ id: "long-stuck", updatedAt: "2026-07-30T08:00:00.000Z" }), // 2h ago
    ];
    const report = buildStaleReport(jobs, NOW, { thresholdMs: 60 * 1000 });
    expect(report.entries.map((e) => e.job.id)).toEqual(["long-stuck"]);
    expect(report.thresholdMs).toBe(60 * 1000);
  });

  it("does not treat a job stuck exactly at the threshold as stale", () => {
    const jobs = [
      job({ id: "exactly-threshold", updatedAt: "2026-07-30T09:59:00.000Z" }), // 60s ago
      job({ id: "one-ms-more", updatedAt: "2026-07-30T09:58:59.999Z" }),
    ];
    const report = buildStaleReport(jobs, NOW, { thresholdMs: 60 * 1000 });
    // Exactly at threshold is not "> threshold"; one ms more counts.
    expect(report.entries.map((e) => e.job.id)).toEqual(["one-ms-more"]);
  });

  it("treats a negative or non-finite threshold as zero", () => {
    const jobs = [job({ id: "one-ms-old", updatedAt: "2026-07-30T09:59:59.999Z" })];
    expect(buildStaleReport(jobs, NOW, { thresholdMs: -5000 }).thresholdMs).toBe(0);
    expect(buildStaleReport(jobs, NOW, { thresholdMs: Number.NaN }).thresholdMs).toBe(0);
    expect(buildStaleReport(jobs, NOW, { thresholdMs: -5000 }).totalStale).toBe(1);
  });

  it("trims to the limit while keeping totals and maxStuckForMs honest", () => {
    const report = buildStaleReport(
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
    expect(report.totalStale).toBe(4);
    expect(report.hidden).toBe(2);
    expect(report.maxStuckForMs).toBe(4 * HOUR);
  });

  it("ignores a non-integer limit and shows everything", () => {
    const jobs = [
      job({ id: "j1", updatedAt: "2026-07-30T08:00:00.000Z" }),
      job({ id: "j2", updatedAt: "2026-07-30T09:00:00.000Z" }),
    ];
    expect(buildStaleReport(jobs, NOW, { limit: 0 }).entries).toHaveLength(0);
    expect(buildStaleReport(jobs, NOW, { limit: 1.5 }).entries).toHaveLength(2);
    expect(buildStaleReport(jobs, NOW, {}).entries).toHaveLength(2);
  });

  it("does not mutate the input array order", () => {
    const jobs = [
      job({ id: "recent", updatedAt: "2026-07-30T09:30:00.000Z" }),
      job({ id: "ancient", updatedAt: "2026-07-30T06:00:00.000Z" }),
    ];
    buildStaleReport(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(["recent", "ancient"]);
  });
});
