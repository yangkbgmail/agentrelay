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
const HOUR = 3_600_000;

describe("buildOverdueReport", () => {
  it("returns an empty report when nothing is waiting", () => {
    const report = buildOverdueReport([], NOW);
    expect(report).toEqual({
      entries: [],
      totalOverdue: 0,
      hidden: 0,
      worstOverdueByMs: 0,
      graceMs: 0,
    });
  });

  it("ignores jobs that are not waiting_for_reset even if their resetAt has passed", () => {
    const report = buildOverdueReport(
      [job({ status: "completed" }), job({ status: "queued" }), job({ status: "resuming" }), job({ status: "failed" })],
      NOW
    );
    expect(report.totalOverdue).toBe(0);
    expect(report.entries).toHaveLength(0);
  });

  it("ignores waiting jobs with a missing or unparseable resetAt", () => {
    const report = buildOverdueReport(
      [job({ id: "no-reset", resetAt: null }), job({ id: "bad-reset", resetAt: "not-a-date" })],
      NOW
    );
    expect(report.totalOverdue).toBe(0);
  });

  it("excludes jobs whose reset is still in the future", () => {
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T11:00:00.000Z" })], NOW);
    expect(report.totalOverdue).toBe(0);
  });

  it("includes a job past its reset and reports how overdue it is", () => {
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T09:00:00.000Z" })], NOW);
    expect(report.totalOverdue).toBe(1);
    expect(report.entries[0].overdueByMs).toBe(HOUR);
    expect(report.entries[0].position).toBe(1);
    expect(report.worstOverdueByMs).toBe(HOUR);
  });

  it("orders most-overdue first (earliest reset), with worstOverdueByMs at the top", () => {
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
    expect(report.worstOverdueByMs).toBe(2 * HOUR);
  });

  it("breaks reset-time ties deterministically by createdAt then id", () => {
    const report = buildOverdueReport(
      [
        job({ id: "b", resetAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
        job({ id: "a", resetAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T00:00:00.000Z" }),
        job({ id: "c", resetAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["a", "b", "c"]);
  });

  it("applies a grace window: a job only just due is not yet overdue", () => {
    const jobs = [job({ resetAt: "2026-07-30T09:58:00.000Z" })]; // 2m past
    expect(buildOverdueReport(jobs, NOW, { graceMs: 5 * 60_000 }).totalOverdue).toBe(0);
    expect(buildOverdueReport(jobs, NOW, { graceMs: 60_000 }).totalOverdue).toBe(1);
    expect(buildOverdueReport(jobs, NOW).graceMs).toBe(DEFAULT_OVERDUE_GRACE_MS);
  });

  it("clamps a negative or non-finite grace to 0", () => {
    const jobs = [job({ resetAt: "2026-07-30T09:59:59.999Z" })]; // 1ms past
    expect(buildOverdueReport(jobs, NOW, { graceMs: -1000 }).totalOverdue).toBe(1);
    expect(buildOverdueReport(jobs, NOW, { graceMs: Number.NaN }).graceMs).toBe(0);
  });

  it("trims to limit but keeps honest totals and worstOverdueByMs", () => {
    const report = buildOverdueReport(
      [
        job({ id: "oldest", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ id: "middle", resetAt: "2026-07-30T08:30:00.000Z" }),
        job({ id: "recent", resetAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW,
      { limit: 2 }
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["oldest", "middle"]);
    expect(report.totalOverdue).toBe(3);
    expect(report.hidden).toBe(1);
    expect(report.worstOverdueByMs).toBe(2 * HOUR);
  });

  it("treats a job due exactly at now (0ms past) as not overdue with default grace", () => {
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T10:00:00.000Z" })], NOW);
    expect(report.totalOverdue).toBe(0);
  });
});
