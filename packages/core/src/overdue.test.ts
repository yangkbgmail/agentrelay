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
const HOUR = 60 * 60 * 1000;

describe("buildOverdueReport", () => {
  it("returns an empty report when nothing is overdue", () => {
    const report = buildOverdueReport([], NOW);
    expect(report).toEqual({ entries: [], totalOverdue: 0, hidden: 0, graceMs: 0, worstOverdueMs: 0 });
  });

  it("ignores jobs whose reset is still in the future", () => {
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T11:00:00.000Z" })], NOW);
    expect(report.totalOverdue).toBe(0);
    expect(report.entries).toHaveLength(0);
  });

  it("treats a reset exactly at now as overdue (zero grace)", () => {
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T10:00:00.000Z" })], NOW);
    expect(report.totalOverdue).toBe(1);
    expect(report.entries[0].overdueMs).toBe(0);
  });

  it("ignores jobs that are not waiting_for_reset even when their reset has passed", () => {
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
  });

  it("ignores waiting jobs with a missing or unparseable resetAt", () => {
    const report = buildOverdueReport(
      [
        job({ id: "no-reset", resetAt: null }),
        job({ id: "bad-reset", resetAt: "not a date" }),
        job({ id: "good", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.totalOverdue).toBe(1);
    expect(report.entries.map((e) => e.job.id)).toEqual(["good"]);
  });

  it("ranks the most overdue job first and numbers positions from 1", () => {
    const report = buildOverdueReport(
      [
        job({ id: "recent", resetAt: "2026-07-30T09:30:00.000Z" }),
        job({ id: "ancient", resetAt: "2026-07-30T06:00:00.000Z" }),
        job({ id: "middle", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["ancient", "middle", "recent"]);
    expect(report.entries.map((e) => e.position)).toEqual([1, 2, 3]);
    expect(report.entries[0].overdueMs).toBe(4 * HOUR);
    expect(report.worstOverdueMs).toBe(4 * HOUR);
  });

  it("breaks ties deterministically by createdAt then id", () => {
    const report = buildOverdueReport(
      [
        job({ id: "b", resetAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "a", resetAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "c", resetAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["c", "a", "b"]);
  });

  it("applies a grace period so freshly-due jobs are not flagged", () => {
    const jobs = [
      job({ id: "just-due", resetAt: "2026-07-30T09:58:00.000Z" }), // 2m overdue
      job({ id: "stuck", resetAt: "2026-07-30T09:00:00.000Z" }), // 1h overdue
    ];
    // 5m grace: only the job overdue by more than 5m survives.
    const report = buildOverdueReport(jobs, NOW, { graceMs: 5 * 60 * 1000 });
    expect(report.graceMs).toBe(5 * 60 * 1000);
    expect(report.entries.map((e) => e.job.id)).toEqual(["stuck"]);
    expect(report.totalOverdue).toBe(1);
  });

  it("treats a job exactly at the grace boundary as not yet overdue", () => {
    // resetAt is exactly 5m before now; with a 5m grace the threshold is now-5m,
    // and the filter is resetAt <= threshold, so exactly-at-boundary counts as overdue.
    const atBoundary = buildOverdueReport([job({ resetAt: "2026-07-30T09:55:00.000Z" })], NOW, {
      graceMs: 5 * 60 * 1000,
    });
    expect(atBoundary.totalOverdue).toBe(1);
    // One ms inside the grace window is not overdue.
    const insideGrace = buildOverdueReport([job({ resetAt: "2026-07-30T09:55:00.001Z" })], NOW, {
      graceMs: 5 * 60 * 1000,
    });
    expect(insideGrace.totalOverdue).toBe(0);
  });

  it("ignores a non-positive grace and treats it as zero", () => {
    const jobs = [job({ resetAt: "2026-07-30T09:59:59.000Z" })];
    expect(buildOverdueReport(jobs, NOW, { graceMs: 0 }).totalOverdue).toBe(1);
    expect(buildOverdueReport(jobs, NOW, { graceMs: -1000 }).totalOverdue).toBe(1);
  });

  it("trims to the limit while keeping totals and worst-lag honest", () => {
    const report = buildOverdueReport(
      [
        job({ id: "j1", resetAt: "2026-07-30T06:00:00.000Z" }),
        job({ id: "j2", resetAt: "2026-07-30T07:00:00.000Z" }),
        job({ id: "j3", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ id: "j4", resetAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW,
      { limit: 2 }
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["j1", "j2"]);
    expect(report.totalOverdue).toBe(4);
    expect(report.hidden).toBe(2);
    expect(report.worstOverdueMs).toBe(4 * HOUR); // j1, even though j3/j4 are trimmed
  });

  it("does not mutate the input array order", () => {
    const jobs = [
      job({ id: "recent", resetAt: "2026-07-30T09:30:00.000Z" }),
      job({ id: "ancient", resetAt: "2026-07-30T06:00:00.000Z" }),
    ];
    buildOverdueReport(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(["recent", "ancient"]);
  });
});
