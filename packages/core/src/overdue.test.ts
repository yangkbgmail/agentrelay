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
const HOUR = 3_600_000;

describe("buildOverdueReport", () => {
  it("returns an empty report when nothing is overdue", () => {
    const report = buildOverdueReport([], NOW);
    expect(report).toEqual({ entries: [], totalOverdue: 0, hidden: 0, worstOverdueMs: 0, graceMs: 0 });
  });

  it("ignores jobs that are not waiting_for_reset even if their resetAt is in the past", () => {
    const report = buildOverdueReport(
      [
        job({ status: "completed", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "resuming", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "failed", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "queued", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.totalOverdue).toBe(0);
    expect(report.entries).toHaveLength(0);
  });

  it("ignores waiting jobs whose reset is still in the future", () => {
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T12:00:00.000Z" })], NOW);
    expect(report.totalOverdue).toBe(0);
  });

  it("ignores waiting jobs with a missing or unparseable resetAt", () => {
    const report = buildOverdueReport(
      [
        job({ id: "no-reset", resetAt: null }),
        job({ id: "bad-reset", resetAt: "not a date" }),
        job({ id: "stuck", resetAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.totalOverdue).toBe(1);
    expect(report.entries.map((e) => e.job.id)).toEqual(["stuck"]);
  });

  it("flags past-due waiting jobs, worst (oldest reset) first, numbering positions from 1", () => {
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
    expect(report.entries[0].overdueByMs).toBe(4 * HOUR);
    expect(report.worstOverdueMs).toBe(4 * HOUR);
    expect(report.totalOverdue).toBe(3);
    expect(report.hidden).toBe(0);
  });

  it("respects the grace window: a just-due job is not overdue until past grace", () => {
    const jobs = [job({ id: "barely", resetAt: "2026-07-30T09:59:30.000Z" })]; // 30s past due
    expect(buildOverdueReport(jobs, NOW, { graceMs: 60_000 }).totalOverdue).toBe(0);
    expect(buildOverdueReport(jobs, NOW, { graceMs: 10_000 }).totalOverdue).toBe(1);
  });

  it("clamps a negative grace to zero", () => {
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T09:59:59.000Z" })], NOW, { graceMs: -5000 });
    expect(report.graceMs).toBe(0);
    expect(report.totalOverdue).toBe(1);
  });

  it("treats a job exactly at grace boundary as not overdue (strictly greater than grace)", () => {
    // reset was 60s ago, grace is 60s → 60_000 > 60_000 is false.
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T09:59:00.000Z" })], NOW, { graceMs: 60_000 });
    expect(report.totalOverdue).toBe(0);
  });

  it("trims entries to limit but keeps honest totals", () => {
    const report = buildOverdueReport(
      [
        job({ id: "a", resetAt: "2026-07-30T06:00:00.000Z" }),
        job({ id: "b", resetAt: "2026-07-30T07:00:00.000Z" }),
        job({ id: "c", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW,
      { limit: 2 }
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["a", "b"]);
    expect(report.hidden).toBe(1);
    expect(report.totalOverdue).toBe(3);
    expect(report.worstOverdueMs).toBe(4 * HOUR); // still the full-set worst
  });

  it("breaks reset-time ties by createdAt then id, deterministically", () => {
    const report = buildOverdueReport(
      [
        job({ id: "z", resetAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
        job({ id: "a", resetAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
        job({ id: "m", resetAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T00:00:00.000Z" }),
      ],
      NOW
    );
    // oldest createdAt first (m), then id asc among equal createdAt (a before z).
    expect(report.entries.map((e) => e.job.id)).toEqual(["m", "a", "z"]);
  });
});
