import { describe, expect, it } from "vitest";
import type { AgentTool, JobStatus, RelayJob } from "./types.js";
import { computeRelayValue } from "./value.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "proj",
    tool: "claude-code" as AgentTool,
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "completed" as JobStatus,
    resetAt: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("computeRelayValue", () => {
  it("returns an all-zero value for an empty store", () => {
    const v = computeRelayValue([]);
    expect(v).toEqual({
      totalJobs: 0,
      autoResumes: 0,
      resumedJobs: 0,
      manualInterventionsSaved: 0,
      unattendedMs: 0,
      longestUnattendedMs: 0,
      unattendedJobs: 0,
    });
  });

  it("counts a first-try success as zero relay work", () => {
    const v = computeRelayValue([job({ attempts: 1, status: "completed" })]);
    expect(v.autoResumes).toBe(0);
    expect(v.resumedJobs).toBe(0);
    expect(v.manualInterventionsSaved).toBe(0);
    expect(v.unattendedMs).toBe(0);
    expect(v.unattendedJobs).toBe(0);
    expect(v.totalJobs).toBe(1);
  });

  it("counts attempts − 1 as the relay-driven resumes", () => {
    // 3 attempts = 1 initial run + 2 relay resumes.
    const v = computeRelayValue([job({ attempts: 3, status: "completed" })]);
    expect(v.autoResumes).toBe(2);
    expect(v.resumedJobs).toBe(1);
    expect(v.manualInterventionsSaved).toBe(2);
  });

  it("sums unattended lifecycle span only over resolved, relayed jobs", () => {
    const jobs = [
      // relayed + completed: 2h span counts
      job({
        attempts: 2,
        status: "completed",
        createdAt: "2026-08-16T00:00:00.000Z",
        updatedAt: "2026-08-16T02:00:00.000Z",
      }),
      // relayed + failed: 30m span counts
      job({
        attempts: 4,
        status: "failed",
        createdAt: "2026-08-16T00:00:00.000Z",
        updatedAt: "2026-08-16T00:30:00.000Z",
      }),
      // relayed but still in flight: no final span
      job({
        attempts: 2,
        status: "waiting_for_reset",
        createdAt: "2026-08-16T00:00:00.000Z",
        updatedAt: "2026-08-16T05:00:00.000Z",
      }),
      // first-try success: relay never stepped in, span ignored
      job({
        attempts: 1,
        status: "completed",
        createdAt: "2026-08-16T00:00:00.000Z",
        updatedAt: "2026-08-16T09:00:00.000Z",
      }),
    ];
    const v = computeRelayValue(jobs);
    expect(v.unattendedMs).toBe(2 * 3600_000 + 30 * 60_000);
    expect(v.unattendedJobs).toBe(2);
    expect(v.longestUnattendedMs).toBe(2 * 3600_000);
    // autoResumes: (2-1) + (4-1) + (2-1) + 0 = 5
    expect(v.autoResumes).toBe(5);
    expect(v.resumedJobs).toBe(3);
  });

  it("skips negative spans (clock skew) and unparseable timestamps", () => {
    const jobs = [
      job({
        attempts: 2,
        status: "completed",
        createdAt: "2026-08-16T02:00:00.000Z",
        updatedAt: "2026-08-16T00:00:00.000Z", // updated before created
      }),
      job({ attempts: 2, status: "failed", createdAt: "not-a-date", updatedAt: "2026-08-16T00:00:00.000Z" }),
    ];
    const v = computeRelayValue(jobs);
    expect(v.unattendedMs).toBe(0);
    expect(v.unattendedJobs).toBe(0);
    expect(v.longestUnattendedMs).toBe(0);
    // resumes are still counted from attempts even when spans are unusable
    expect(v.autoResumes).toBe(2);
    expect(v.resumedJobs).toBe(2);
  });

  it("guards against a malformed 0/negative attempts count", () => {
    const v = computeRelayValue([job({ attempts: 0 }), job({ attempts: -3 })]);
    expect(v.autoResumes).toBe(0);
    expect(v.resumedJobs).toBe(0);
  });
});
