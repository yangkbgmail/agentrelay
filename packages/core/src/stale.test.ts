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
    expect(report).toEqual({
      entries: [],
      totalStale: 0,
      hidden: 0,
      graceMs: 0,
      maxStaleForMs: 0,
      byStatus: {},
    });
  });

  it("flags resuming and queued jobs but ignores terminal and waiting ones", () => {
    const report = buildStaleReport(
      [
        job({ id: "resuming", status: "resuming" }),
        job({ id: "queued", status: "queued" }),
        job({ id: "waiting", status: "waiting_for_reset" }),
        job({ id: "completed", status: "completed" }),
        job({ id: "failed", status: "failed" }),
        job({ id: "cancelled", status: "cancelled" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id).sort()).toEqual(["queued", "resuming"]);
    expect(report.totalStale).toBe(2);
    expect(report.byStatus).toEqual({ resuming: 1, queued: 1 });
  });

  it("ignores jobs with an unparseable updatedAt", () => {
    const report = buildStaleReport(
      [job({ id: "bad", updatedAt: "not a date" }), job({ id: "good", updatedAt: "2026-07-30T08:00:00.000Z" })],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["good"]);
  });

  it("ranks the most-stale job first and computes staleForMs", () => {
    const report = buildStaleReport(
      [
        job({ id: "recent", updatedAt: "2026-07-30T09:30:00.000Z" }),
        job({ id: "ancient", updatedAt: "2026-07-30T06:00:00.000Z" }),
        job({ id: "mid", updatedAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["ancient", "mid", "recent"]);
    expect(report.entries[0].staleForMs).toBe(4 * HOUR);
    expect(report.maxStaleForMs).toBe(4 * HOUR);
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

  it("honors the grace window so a fresh resume is not flagged", () => {
    const jobs = [
      job({ id: "just-started", updatedAt: "2026-07-30T09:59:30.000Z" }), // 30s ago
      job({ id: "long-wedged", updatedAt: "2026-07-30T08:00:00.000Z" }), // 2h ago
    ];
    const report = buildStaleReport(jobs, NOW, { graceMs: 60 * 1000 });
    expect(report.entries.map((e) => e.job.id)).toEqual(["long-wedged"]);
    expect(report.graceMs).toBe(60 * 1000);
  });

  it("does not treat an update exactly graceMs ago as stale", () => {
    const jobs = [
      job({ id: "exactly-grace", updatedAt: "2026-07-30T09:59:00.000Z" }), // 60s ago
      job({ id: "one-ms-over", updatedAt: "2026-07-30T09:58:59.999Z" }), // 60.001s ago
    ];
    const report = buildStaleReport(jobs, NOW, { graceMs: 60 * 1000 });
    expect(report.entries.map((e) => e.job.id)).toEqual(["one-ms-over"]);
  });

  it("treats a negative or non-finite grace as zero", () => {
    const jobs = [job({ id: "one-ms-ago", updatedAt: "2026-07-30T09:59:59.999Z" })];
    expect(buildStaleReport(jobs, NOW, { graceMs: -5000 }).graceMs).toBe(0);
    expect(buildStaleReport(jobs, NOW, { graceMs: Number.NaN }).graceMs).toBe(0);
    expect(buildStaleReport(jobs, NOW, { graceMs: -5000 }).totalStale).toBe(1);
  });

  it("trims to the limit while keeping totals and byStatus honest", () => {
    const report = buildStaleReport(
      [
        job({ id: "j1", status: "resuming", updatedAt: "2026-07-30T06:00:00.000Z" }),
        job({ id: "j2", status: "resuming", updatedAt: "2026-07-30T07:00:00.000Z" }),
        job({ id: "j3", status: "queued", updatedAt: "2026-07-30T08:00:00.000Z" }),
        job({ id: "j4", status: "queued", updatedAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW,
      { limit: 2 }
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["j1", "j2"]);
    expect(report.totalStale).toBe(4);
    expect(report.hidden).toBe(2);
    expect(report.maxStaleForMs).toBe(4 * HOUR);
    // byStatus counts all four, not just the shown two.
    expect(report.byStatus).toEqual({ resuming: 2, queued: 2 });
  });
});
