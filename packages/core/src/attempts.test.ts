import { describe, expect, it } from "vitest";
import { summarizeAttempts } from "./attempts.js";
import type { RelayJob } from "./types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "proj",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("summarizeAttempts", () => {
  it("returns an empty shape for no jobs", () => {
    expect(summarizeAttempts([])).toEqual({
      total: 0,
      totalAttempts: 0,
      retriedJobs: 0,
      neverResumed: 0,
      maxAttempts: 0,
      meanAttempts: null,
      buckets: [],
    });
  });

  it("buckets jobs by attempt count, ascending", () => {
    const dist = summarizeAttempts([
      job({ attempts: 1 }),
      job({ attempts: 1 }),
      job({ attempts: 3 }),
      job({ attempts: 0 }),
    ]);
    expect(dist.total).toBe(4);
    expect(dist.buckets).toEqual([
      { attempts: 0, count: 1 },
      { attempts: 1, count: 2 },
      { attempts: 3, count: 1 },
    ]);
  });

  it("sums totalAttempts and counts retried jobs (attempts > 1)", () => {
    const dist = summarizeAttempts([job({ attempts: 1 }), job({ attempts: 2 }), job({ attempts: 4 })]);
    expect(dist.totalAttempts).toBe(7);
    expect(dist.retriedJobs).toBe(2);
    expect(dist.maxAttempts).toBe(4);
  });

  it("counts never-resumed jobs (attempts === 0) separately from retried", () => {
    const dist = summarizeAttempts([job({ attempts: 0 }), job({ attempts: 0 }), job({ attempts: 1 })]);
    expect(dist.neverResumed).toBe(2);
    expect(dist.retriedJobs).toBe(0);
  });

  it("computes the mean attempts per job", () => {
    const dist = summarizeAttempts([job({ attempts: 1 }), job({ attempts: 2 }), job({ attempts: 3 })]);
    expect(dist.meanAttempts).toBeCloseTo(2);
  });

  it("clamps negative / fractional / non-finite attempts to a 0-or-more integer bucket", () => {
    const dist = summarizeAttempts([job({ attempts: -5 }), job({ attempts: 2.9 }), job({ attempts: Number.NaN })]);
    // -5 → 0, NaN → 0, 2.9 → 2
    expect(dist.buckets).toEqual([
      { attempts: 0, count: 2 },
      { attempts: 2, count: 1 },
    ]);
    expect(dist.totalAttempts).toBe(2);
    expect(dist.neverResumed).toBe(2);
  });

  it("mirrors the stats totals it overlaps with", () => {
    const jobs = [job({ attempts: 0 }), job({ attempts: 1 }), job({ attempts: 1 }), job({ attempts: 5 })];
    const dist = summarizeAttempts(jobs);
    // totalAttempts and retriedJobs use the same definitions as computeStats.
    expect(dist.totalAttempts).toBe(7);
    expect(dist.retriedJobs).toBe(1);
  });
});
