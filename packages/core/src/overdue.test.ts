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
    expect(report).toEqual({ entries: [], totalOverdue: 0, hidden: 0, maxOverdueMs: 0, graceMs: 0 });
  });

  it("ignores jobs that are not waiting_for_reset", () => {
    const report = buildOverdueReport(
      [
        job({ status: "completed", resetAt: "2026-07-30T09:00:00.000Z" }),
        job({ status: "queued", resetAt: "2026-07-30T09:00:00.000Z" }),
        job({ status: "resuming", resetAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.totalOverdue).toBe(0);
    expect(report.entries).toHaveLength(0);
  });

  it("ignores waiting jobs whose reset is still in the future", () => {
    const report = buildOverdueReport(
      [
        job({ id: "future", resetAt: "2026-07-30T11:00:00.000Z" }),
        job({ id: "past", resetAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["past"]);
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

  it("orders entries most-overdue first and numbers positions from 1", () => {
    const report = buildOverdueReport(
      [
        job({ id: "recent", resetAt: "2026-07-30T09:45:00.000Z" }),
        job({ id: "oldest", resetAt: "2026-07-30T07:00:00.000Z" }),
        job({ id: "mid", resetAt: "2026-07-30T08:30:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => [e.job.id, e.position])).toEqual([
      ["oldest", 1],
      ["mid", 2],
      ["recent", 3],
    ]);
  });

  it("computes overdueMs and maxOverdueMs from now minus reset", () => {
    const report = buildOverdueReport([job({ id: "j", resetAt: "2026-07-30T09:00:00.000Z" })], NOW);
    // 09:00 -> 10:00 is one hour overdue.
    expect(report.entries[0].overdueMs).toBe(60 * 60 * 1000);
    expect(report.maxOverdueMs).toBe(60 * 60 * 1000);
  });

  it("breaks reset-time ties by createdAt then id", () => {
    const report = buildOverdueReport(
      [
        job({ id: "b", resetAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
        job({ id: "a", resetAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
        job({ id: "c", resetAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T00:30:00.000Z" }),
      ],
      NOW
    );
    // Same resetAt: oldest createdAt first (c), then id asc (a before b).
    expect(report.entries.map((e) => e.job.id)).toEqual(["c", "a", "b"]);
  });

  it("respects a grace window: jobs overdue by less than graceMs are excluded", () => {
    const report = buildOverdueReport(
      [
        job({ id: "just-due", resetAt: "2026-07-30T09:59:00.000Z" }), // 1m overdue
        job({ id: "stuck", resetAt: "2026-07-30T09:00:00.000Z" }), // 60m overdue
      ],
      NOW,
      { graceMs: 5 * 60 * 1000 } // 5m grace
    );
    expect(report.graceMs).toBe(5 * 60 * 1000);
    expect(report.entries.map((e) => e.job.id)).toEqual(["stuck"]);
    expect(report.totalOverdue).toBe(1);
  });

  it("clamps a negative graceMs to 0", () => {
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T09:59:59.999Z" })], NOW, { graceMs: -1000 });
    expect(report.graceMs).toBe(0);
    expect(report.totalOverdue).toBe(1);
  });

  it("excludes a job whose reset is exactly now (not strictly past)", () => {
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T10:00:00.000Z" })], NOW);
    expect(report.totalOverdue).toBe(0);
  });

  it("trims entries to limit but keeps totals and maxOverdueMs honest", () => {
    const report = buildOverdueReport(
      [
        job({ id: "oldest", resetAt: "2026-07-30T07:00:00.000Z" }),
        job({ id: "mid", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ id: "recent", resetAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW,
      { limit: 2 }
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["oldest", "mid"]);
    expect(report.totalOverdue).toBe(3);
    expect(report.hidden).toBe(1);
    // maxOverdueMs reflects the full set (oldest = 3h), not just the shown rows.
    expect(report.maxOverdueMs).toBe(3 * 60 * 60 * 1000);
  });
});
