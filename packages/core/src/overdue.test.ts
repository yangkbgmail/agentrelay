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

describe("buildOverdueReport", () => {
  it("returns an empty report when nothing is waiting", () => {
    const report = buildOverdueReport([], NOW);
    expect(report).toEqual({
      entries: [],
      totalOverdue: 0,
      hidden: 0,
      longestOverdueMs: 0,
      graceMs: DEFAULT_OVERDUE_GRACE_MS,
    });
  });

  it("ignores jobs that are not waiting_for_reset even if their resetAt is in the past", () => {
    const report = buildOverdueReport(
      [
        job({ status: "completed", resetAt: "2026-07-30T05:00:00.000Z" }),
        job({ status: "queued", resetAt: "2026-07-30T05:00:00.000Z" }),
        job({ status: "resuming", resetAt: "2026-07-30T05:00:00.000Z" }),
        job({ status: "failed", resetAt: "2026-07-30T05:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.totalOverdue).toBe(0);
    expect(report.entries).toHaveLength(0);
  });

  it("ignores waiting jobs with a missing or unparseable resetAt", () => {
    const report = buildOverdueReport(
      [
        job({ id: "no-reset", resetAt: null }),
        job({ id: "bad-reset", resetAt: "not a date" }),
        job({ id: "good", resetAt: "2026-07-30T05:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["good"]);
  });

  it("excludes jobs still within the grace window and includes those past it", () => {
    const report = buildOverdueReport(
      [
        // 30s past due — inside the default 60s grace, not overdue yet.
        job({ id: "fresh", resetAt: new Date(NOW - 30_000).toISOString() }),
        // 5m past due — comfortably overdue.
        job({ id: "stale", resetAt: new Date(NOW - 5 * 60_000).toISOString() }),
        // Due exactly at now — inside grace.
        job({ id: "justnow", resetAt: new Date(NOW).toISOString() }),
        // Not due yet at all.
        job({ id: "future", resetAt: new Date(NOW + 60 * 60_000).toISOString() }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["stale"]);
    expect(report.totalOverdue).toBe(1);
  });

  it("treats a job exactly at the grace cutoff as overdue (inclusive)", () => {
    const report = buildOverdueReport(
      [job({ id: "edge", resetAt: new Date(NOW - DEFAULT_OVERDUE_GRACE_MS).toISOString() })],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["edge"]);
  });

  it("with graceMs 0 reports every due job, including one exactly at now", () => {
    const report = buildOverdueReport(
      [
        job({ id: "atnow", resetAt: new Date(NOW).toISOString() }),
        job({ id: "past", resetAt: new Date(NOW - 1000).toISOString() }),
        job({ id: "future", resetAt: new Date(NOW + 1000).toISOString() }),
      ],
      NOW,
      { graceMs: 0 }
    );
    expect(report.entries.map((e) => e.job.id).sort()).toEqual(["atnow", "past"]);
  });

  it("orders entries most-overdue first and numbers positions from 1", () => {
    const report = buildOverdueReport(
      [
        job({ id: "recent", resetAt: new Date(NOW - 5 * 60_000).toISOString() }),
        job({ id: "ancient", resetAt: new Date(NOW - 60 * 60_000).toISOString() }),
        job({ id: "middle", resetAt: new Date(NOW - 20 * 60_000).toISOString() }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["ancient", "middle", "recent"]);
    expect(report.entries.map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it("computes overdueByMs and longestOverdueMs against now", () => {
    const report = buildOverdueReport(
      [
        job({ id: "a", resetAt: new Date(NOW - 10 * 60_000).toISOString() }),
        job({ id: "b", resetAt: new Date(NOW - 90 * 60_000).toISOString() }),
      ],
      NOW
    );
    const b = report.entries.find((e) => e.job.id === "b");
    const a = report.entries.find((e) => e.job.id === "a");
    expect(b?.overdueByMs).toBe(90 * 60_000);
    expect(a?.overdueByMs).toBe(10 * 60_000);
    expect(report.longestOverdueMs).toBe(90 * 60_000);
  });

  it("breaks ties deterministically by createdAt then id", () => {
    const reset = new Date(NOW - 30 * 60_000).toISOString();
    const report = buildOverdueReport(
      [
        job({ id: "b", resetAt: reset, createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "a", resetAt: reset, createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "c", resetAt: reset, createdAt: "2026-07-30T01:00:00.000Z" }),
      ],
      NOW
    );
    // Same reset → oldest createdAt first (c), then id order (a before b).
    expect(report.entries.map((e) => e.job.id)).toEqual(["c", "a", "b"]);
  });

  it("trims to the limit while keeping totals and longestOverdueMs honest", () => {
    const report = buildOverdueReport(
      [
        job({ id: "j1", resetAt: new Date(NOW - 60 * 60_000).toISOString() }),
        job({ id: "j2", resetAt: new Date(NOW - 50 * 60_000).toISOString() }),
        job({ id: "j3", resetAt: new Date(NOW - 40 * 60_000).toISOString() }),
        job({ id: "j4", resetAt: new Date(NOW - 30 * 60_000).toISOString() }),
      ],
      NOW,
      { limit: 2 }
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["j1", "j2"]);
    expect(report.totalOverdue).toBe(4);
    expect(report.hidden).toBe(2);
    expect(report.longestOverdueMs).toBe(60 * 60_000);
  });

  it("ignores a non-positive or non-integer limit and shows everything", () => {
    const jobs = [
      job({ id: "j1", resetAt: new Date(NOW - 60 * 60_000).toISOString() }),
      job({ id: "j2", resetAt: new Date(NOW - 50 * 60_000).toISOString() }),
    ];
    expect(buildOverdueReport(jobs, NOW, { limit: 0 }).entries).toHaveLength(0);
    expect(buildOverdueReport(jobs, NOW, { limit: 1.5 }).entries).toHaveLength(2);
    expect(buildOverdueReport(jobs, NOW, {}).entries).toHaveLength(2);
  });

  it("falls back to the default grace for a negative or non-finite graceMs", () => {
    const fresh = job({ id: "fresh", resetAt: new Date(NOW - 30_000).toISOString() });
    expect(buildOverdueReport([fresh], NOW, { graceMs: -5 }).totalOverdue).toBe(0);
    expect(buildOverdueReport([fresh], NOW, { graceMs: Number.NaN }).totalOverdue).toBe(0);
    expect(buildOverdueReport([fresh], NOW, { graceMs: Number.POSITIVE_INFINITY }).totalOverdue).toBe(0);
  });

  it("does not mutate the input array order", () => {
    const jobs = [
      job({ id: "recent", resetAt: new Date(NOW - 5 * 60_000).toISOString() }),
      job({ id: "ancient", resetAt: new Date(NOW - 60 * 60_000).toISOString() }),
    ];
    buildOverdueReport(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(["recent", "ancient"]);
  });
});
