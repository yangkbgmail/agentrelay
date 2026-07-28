import { describe, expect, it } from "vitest";
import { DEFAULT_OVERDUE_THRESHOLD_MS, selectOverdueJobs } from "./overdue.js";
import type { AgentTool, JobStatus, RelayJob } from "./types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "proj",
    tool: "claude-code" as AgentTool,
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "waiting_for_reset" as JobStatus,
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-13T12:00:00.000Z");
/** An ISO string `mins` minutes before NOW. */
function agoMinutes(mins: number): string {
  return new Date(NOW - mins * 60_000).toISOString();
}
/** An ISO string `mins` minutes after NOW. */
function inMinutes(mins: number): string {
  return new Date(NOW + mins * 60_000).toISOString();
}

describe("selectOverdueJobs", () => {
  it("returns nothing for an empty job list", () => {
    const report = selectOverdueJobs([], NOW);
    expect(report.jobs).toEqual([]);
    expect(report.totalWaiting).toBe(0);
    expect(report.maxOverdueMs).toBe(0);
  });

  it("flags a job past its reset by more than the threshold", () => {
    const j = job({ resetAt: agoMinutes(10) });
    const report = selectOverdueJobs([j], NOW);
    expect(report.jobs).toHaveLength(1);
    expect(report.jobs[0].job.id).toBe(j.id);
    expect(report.jobs[0].overdueMs).toBe(10 * 60_000);
    expect(report.totalWaiting).toBe(1);
    expect(report.maxOverdueMs).toBe(10 * 60_000);
  });

  it("counts a barely-late job as waiting but not overdue (within threshold)", () => {
    const j = job({ resetAt: agoMinutes(0.5) }); // 30s ago, under the 60s default
    const report = selectOverdueJobs([j], NOW);
    expect(report.jobs).toEqual([]);
    expect(report.totalWaiting).toBe(1);
    expect(report.maxOverdueMs).toBe(0);
  });

  it("does not flag a job whose reset is still in the future", () => {
    const j = job({ resetAt: inMinutes(30) });
    const report = selectOverdueJobs([j], NOW);
    expect(report.jobs).toEqual([]);
    expect(report.totalWaiting).toBe(1);
  });

  it("only considers waiting_for_reset jobs", () => {
    const jobs = [
      job({ status: "queued", resetAt: agoMinutes(10) }),
      job({ status: "resuming", resetAt: agoMinutes(10) }),
      job({ status: "completed", resetAt: agoMinutes(10) }),
      job({ status: "failed", resetAt: agoMinutes(10) }),
      job({ status: "cancelled", resetAt: agoMinutes(10) }),
    ];
    const report = selectOverdueJobs(jobs, NOW);
    expect(report.jobs).toEqual([]);
    expect(report.totalWaiting).toBe(0);
  });

  it("ignores jobs with a null or unparseable resetAt", () => {
    const jobs = [job({ resetAt: null }), job({ resetAt: "not-a-date" }), job({ resetAt: agoMinutes(10) })];
    const report = selectOverdueJobs(jobs, NOW);
    expect(report.jobs).toHaveLength(1);
    expect(report.totalWaiting).toBe(1); // only the one parseable waiting job
  });

  it("ranks most-overdue first", () => {
    const a = job({ id: "a", resetAt: agoMinutes(5) });
    const b = job({ id: "b", resetAt: agoMinutes(30) });
    const c = job({ id: "c", resetAt: agoMinutes(15) });
    const report = selectOverdueJobs([a, b, c], NOW);
    expect(report.jobs.map((o) => o.job.id)).toEqual(["b", "c", "a"]);
    expect(report.maxOverdueMs).toBe(30 * 60_000);
  });

  it("breaks overdue ties by createdAt then id (deterministic)", () => {
    const reset = agoMinutes(10);
    const a = job({ id: "zzz", resetAt: reset, createdAt: "2026-07-13T00:00:00.000Z" });
    const b = job({ id: "aaa", resetAt: reset, createdAt: "2026-07-13T00:00:00.000Z" });
    const older = job({ id: "mmm", resetAt: reset, createdAt: "2026-07-12T00:00:00.000Z" });
    const report = selectOverdueJobs([a, b, older], NOW);
    // same overdueMs → oldest createdAt first, then id asc
    expect(report.jobs.map((o) => o.job.id)).toEqual(["mmm", "aaa", "zzz"]);
  });

  it("honours a custom threshold", () => {
    const j = job({ resetAt: agoMinutes(5) }); // 5m ago
    expect(selectOverdueJobs([j], NOW, { thresholdMs: 10 * 60_000 }).jobs).toEqual([]);
    expect(selectOverdueJobs([j], NOW, { thresholdMs: 60_000 }).jobs).toHaveLength(1);
  });

  it("clamps a negative threshold to 0 (reports every past-due job)", () => {
    const j = job({ resetAt: agoMinutes(0.1) }); // 6s ago
    const report = selectOverdueJobs([j], NOW, { thresholdMs: -5000 });
    expect(report.jobs).toHaveLength(1);
  });

  it("does not flag a job due exactly at now (overdueMs must exceed threshold)", () => {
    const j = job({ resetAt: new Date(NOW).toISOString() });
    const report = selectOverdueJobs([j], NOW, { thresholdMs: 0 });
    expect(report.jobs).toEqual([]); // 0 > 0 is false
    expect(report.totalWaiting).toBe(1);
  });

  it("exposes a sane default threshold", () => {
    expect(DEFAULT_OVERDUE_THRESHOLD_MS).toBe(60_000);
  });
});
