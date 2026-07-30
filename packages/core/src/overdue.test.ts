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
    expect(report).toEqual({ entries: [], totalOverdue: 0, hidden: 0, maxOverdueByMs: 0 });
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
    expect(report.totalOverdue).toBe(0);
    expect(report.entries).toHaveLength(0);
  });

  it("ignores waiting jobs whose reset time is still in the future", () => {
    const report = buildOverdueReport([job({ id: "future", resetAt: "2026-07-30T11:00:00.000Z" })], NOW);
    expect(report.totalOverdue).toBe(0);
  });

  it("treats a reset time exactly at now as overdue (a tick would resume it)", () => {
    const report = buildOverdueReport([job({ id: "exact", resetAt: new Date(NOW).toISOString() })], NOW);
    expect(report.totalOverdue).toBe(1);
    expect(report.entries[0].overdueByMs).toBe(0);
  });

  it("ignores waiting jobs with a missing or unparseable resetAt", () => {
    const report = buildOverdueReport(
      [job({ id: "no-reset", resetAt: null }), job({ id: "bad-reset", resetAt: "not-a-date" })],
      NOW
    );
    expect(report.totalOverdue).toBe(0);
  });

  it("computes overdueByMs from now minus resetAt", () => {
    const report = buildOverdueReport([job({ id: "a", resetAt: "2026-07-30T09:30:00.000Z" })], NOW);
    expect(report.entries[0].overdueByMs).toBe(30 * 60 * 1000);
  });

  it("orders most-overdue (earliest resetAt) first with 1-based positions", () => {
    const report = buildOverdueReport(
      [
        job({ id: "recent", resetAt: "2026-07-30T09:45:00.000Z" }),
        job({ id: "oldest", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ id: "middle", resetAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["oldest", "middle", "recent"]);
    expect(report.entries.map((e) => e.position)).toEqual([1, 2, 3]);
    expect(report.maxOverdueByMs).toBe(2 * 60 * 60 * 1000);
  });

  it("breaks reset-time ties by createdAt then id (deterministic)", () => {
    const report = buildOverdueReport(
      [
        job({ id: "z", resetAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
        job({ id: "a", resetAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
        job({ id: "early", resetAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T00:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["early", "a", "z"]);
  });

  it("trims to limit but keeps totals honest and reports hidden", () => {
    const report = buildOverdueReport(
      [
        job({ id: "o1", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ id: "o2", resetAt: "2026-07-30T08:30:00.000Z" }),
        job({ id: "o3", resetAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW,
      2
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["o1", "o2"]);
    expect(report.totalOverdue).toBe(3);
    expect(report.hidden).toBe(1);
    expect(report.maxOverdueByMs).toBe(2 * 60 * 60 * 1000);
  });

  it("ignores a non-integer or negative limit and returns all entries", () => {
    const jobs = [
      job({ id: "o1", resetAt: "2026-07-30T08:00:00.000Z" }),
      job({ id: "o2", resetAt: "2026-07-30T09:00:00.000Z" }),
    ];
    expect(buildOverdueReport(jobs, NOW, 1.5).entries).toHaveLength(2);
    expect(buildOverdueReport(jobs, NOW, -1).entries).toHaveLength(2);
  });
});
