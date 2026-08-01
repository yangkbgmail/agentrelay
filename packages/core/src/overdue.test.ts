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
    expect(report).toEqual({ entries: [], totalOverdue: 0, hidden: 0, worstOverdueByMs: 0 });
  });

  it("ignores jobs that are not waiting_for_reset even when their resetAt is past", () => {
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

  it("ignores waiting jobs whose reset is still in the future", () => {
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T12:00:00.000Z" })], NOW);
    expect(report.totalOverdue).toBe(0);
  });

  it("ignores a waiting job resetting exactly at now (due, not overdue)", () => {
    const report = buildOverdueReport([job({ resetAt: new Date(NOW).toISOString() })], NOW);
    expect(report.totalOverdue).toBe(0);
  });

  it("ignores waiting jobs with a missing or unparseable resetAt", () => {
    const report = buildOverdueReport(
      [
        job({ id: "no-reset", resetAt: null }),
        job({ id: "bad-reset", resetAt: "not a date" }),
        job({ id: "good", resetAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.totalOverdue).toBe(1);
    expect(report.entries.map((e) => e.job.id)).toEqual(["good"]);
  });

  it("orders entries worst-first (earliest reset) and numbers positions from 1", () => {
    const report = buildOverdueReport(
      [
        job({ id: "mild", resetAt: new Date(NOW - HOUR).toISOString() }),
        job({ id: "worst", resetAt: new Date(NOW - 5 * HOUR).toISOString() }),
        job({ id: "mid", resetAt: new Date(NOW - 3 * HOUR).toISOString() }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["worst", "mid", "mild"]);
    expect(report.entries.map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it("computes overdueByMs as now minus the reset time", () => {
    const report = buildOverdueReport([job({ resetAt: new Date(NOW - 2 * HOUR).toISOString() })], NOW);
    expect(report.entries[0].overdueByMs).toBe(2 * HOUR);
  });

  it("reports the worst lateness across the full set", () => {
    const report = buildOverdueReport(
      [job({ resetAt: new Date(NOW - HOUR).toISOString() }), job({ resetAt: new Date(NOW - 4 * HOUR).toISOString() })],
      NOW
    );
    expect(report.worstOverdueByMs).toBe(4 * HOUR);
  });

  it("breaks reset-time ties by createdAt then id, deterministically", () => {
    const reset = new Date(NOW - HOUR).toISOString();
    const report = buildOverdueReport(
      [
        job({ id: "b", resetAt: reset, createdAt: "2026-07-30T00:00:00.000Z" }),
        job({ id: "a", resetAt: reset, createdAt: "2026-07-30T00:00:00.000Z" }),
        job({ id: "older", resetAt: reset, createdAt: "2026-07-29T00:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["older", "a", "b"]);
  });

  it("trims entries to limit but keeps totals and worst honest", () => {
    const report = buildOverdueReport(
      [
        job({ id: "j1", resetAt: new Date(NOW - HOUR).toISOString() }),
        job({ id: "j2", resetAt: new Date(NOW - 2 * HOUR).toISOString() }),
        job({ id: "j3", resetAt: new Date(NOW - 3 * HOUR).toISOString() }),
      ],
      NOW,
      1
    );
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].job.id).toBe("j3");
    expect(report.totalOverdue).toBe(3);
    expect(report.hidden).toBe(2);
    expect(report.worstOverdueByMs).toBe(3 * HOUR);
  });

  it("treats limit 0 as showing no rows while totals still count all", () => {
    const report = buildOverdueReport([job({ resetAt: new Date(NOW - HOUR).toISOString() })], NOW, 0);
    expect(report.entries).toHaveLength(0);
    expect(report.totalOverdue).toBe(1);
    expect(report.hidden).toBe(1);
  });
});
