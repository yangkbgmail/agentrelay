import { describe, expect, it } from "vitest";
import { buildRelayReport, DEFAULT_REPORT_TOP } from "./report.js";
import type { AgentTool, JobStatus, RateLimitDetection, RelayJob } from "./types.js";

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
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function detection(overrides: Partial<RateLimitDetection> = {}): RateLimitDetection {
  return {
    pattern: "clock-time",
    rawMatch: "resets at 5pm",
    resetAt: "2026-07-13T17:00:00.000Z",
    detectedAt: "2026-07-13T12:00:00.000Z",
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-13T12:00:00.000Z");

describe("buildRelayReport", () => {
  it("returns an empty-but-well-formed shape for no jobs", () => {
    const report = buildRelayReport([], { nowMs: NOW });
    expect(report.generatedAtMs).toBe(NOW);
    expect(report.totalJobs).toBe(0);
    expect(report.stats.total).toBe(0);
    expect(report.errorTotals).toEqual({ totalWithErrors: 0, distinctSignatures: 0 });
    expect(report.topErrors).toEqual([]);
    expect(report.patternTotals).toEqual({ total: 0, withDetection: 0, withoutDetection: 0 });
    expect(report.topPatterns).toEqual([]);
    expect(report.nextResume).toBeNull();
  });

  it("composes stats, error, pattern, and next-resume views", () => {
    const jobs = [
      job({ status: "completed" }),
      job({ status: "failed", lastError: "boom: network" }),
      job({ status: "waiting_for_reset", resetAt: "2026-07-13T17:00:00.000Z", lastRateLimit: detection() }),
    ];
    const report = buildRelayReport(jobs, { nowMs: NOW });

    expect(report.totalJobs).toBe(3);
    // stats delegated to computeStats
    expect(report.stats.total).toBe(3);
    expect(report.stats.active).toBe(1);
    expect(report.stats.terminal).toBe(2);
    // error breakdown delegated to computeErrorBreakdown
    expect(report.errorTotals).toEqual({ totalWithErrors: 1, distinctSignatures: 1 });
    expect(report.topErrors).toHaveLength(1);
    expect(report.topErrors[0].signature).toBe("boom: network");
    // pattern summary delegated to summarizeRateLimitPatterns
    expect(report.patternTotals).toEqual({ total: 3, withDetection: 1, withoutDetection: 2 });
    expect(report.topPatterns).toHaveLength(1);
    expect(report.topPatterns[0].pattern).toBe("clock-time");
    // next resume delegated to selectNextResume with the injected clock
    expect(report.nextResume).not.toBeNull();
    expect(report.nextResume?.job.id).toBe(jobs[2].id);
    expect(report.nextResume?.dueInMs).toBe(Date.parse("2026-07-13T17:00:00.000Z") - NOW);
    expect(report.nextResume?.due).toBe(false);
  });

  it("truncates topErrors to DEFAULT_REPORT_TOP while totals count everything", () => {
    // 7 distinct failure reasons.
    const jobs = Array.from({ length: 7 }, (_, i) => job({ status: "failed", lastError: `reason ${i}` }));
    const report = buildRelayReport(jobs, { nowMs: NOW });
    expect(report.errorTotals.totalWithErrors).toBe(7);
    expect(report.errorTotals.distinctSignatures).toBe(7);
    expect(report.topErrors).toHaveLength(DEFAULT_REPORT_TOP);
  });

  it("truncates topPatterns to DEFAULT_REPORT_TOP while totals count everything", () => {
    const jobs = Array.from({ length: 7 }, (_, i) =>
      job({ status: "waiting_for_reset", lastRateLimit: detection({ pattern: `pattern-${i}` }) })
    );
    const report = buildRelayReport(jobs, { nowMs: NOW });
    expect(report.patternTotals.total).toBe(7);
    expect(report.patternTotals.withDetection).toBe(7);
    expect(report.topPatterns).toHaveLength(DEFAULT_REPORT_TOP);
  });

  it("honors a custom topErrors/topPatterns cap", () => {
    const jobs = [
      ...Array.from({ length: 4 }, (_, i) => job({ status: "failed", lastError: `e${i}` })),
      ...Array.from({ length: 4 }, (_, i) =>
        job({ status: "waiting_for_reset", lastRateLimit: detection({ pattern: `p${i}` }) })
      ),
    ];
    const report = buildRelayReport(jobs, { nowMs: NOW, topErrors: 2, topPatterns: 1 });
    expect(report.topErrors).toHaveLength(2);
    expect(report.topPatterns).toHaveLength(1);
  });

  it("treats a non-positive cap as uncapped (include all)", () => {
    const jobs = Array.from({ length: 8 }, (_, i) => job({ status: "failed", lastError: `e${i}` }));
    const report = buildRelayReport(jobs, { nowMs: NOW, topErrors: 0 });
    expect(report.topErrors).toHaveLength(8);
  });

  it("does not mutate the input job list", () => {
    const jobs = [job({ status: "failed", lastError: "x" })];
    const snapshot = JSON.stringify(jobs);
    buildRelayReport(jobs, { nowMs: NOW });
    expect(JSON.stringify(jobs)).toBe(snapshot);
  });
});
