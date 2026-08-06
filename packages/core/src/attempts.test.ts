import { describe, expect, it } from "vitest";
import { computeAttemptDistribution } from "./attempts.js";
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

describe("computeAttemptDistribution", () => {
  it("returns an empty shape for no jobs", () => {
    expect(computeAttemptDistribution([])).toEqual({
      total: 0,
      totalAttempts: 0,
      retriedJobs: 0,
      maxAttempts: 0,
      meanAttempts: null,
      buckets: [],
    });
  });

  it("buckets jobs by their attempts count, ascending", () => {
    const dist = computeAttemptDistribution([
      job({ attempts: 1 }),
      job({ attempts: 1 }),
      job({ attempts: 3 }),
      job({ attempts: 0 }),
    ]);
    expect(dist.total).toBe(4);
    expect(dist.buckets.map((b) => b.attempts)).toEqual([0, 1, 3]);
    expect(dist.buckets.map((b) => b.count)).toEqual([1, 2, 1]);
  });

  it("splits each bucket into active vs terminal", () => {
    const dist = computeAttemptDistribution([
      job({ attempts: 2, status: "waiting_for_reset" }),
      job({ attempts: 2, status: "resuming" }),
      job({ attempts: 2, status: "completed" }),
      job({ attempts: 2, status: "cancelled" }),
    ]);
    const two = dist.buckets.find((b) => b.attempts === 2);
    expect(two).toBeDefined();
    expect(two?.count).toBe(4);
    expect(two?.active).toBe(2); // waiting_for_reset + resuming
    expect(two?.terminal).toBe(2); // completed + cancelled
  });

  it("mirrors stats definitions: totalAttempts sums, retriedJobs counts attempts>1", () => {
    const dist = computeAttemptDistribution([
      job({ attempts: 0 }),
      job({ attempts: 1 }),
      job({ attempts: 4 }),
      job({ attempts: 2 }),
    ]);
    expect(dist.totalAttempts).toBe(0 + 1 + 4 + 2);
    expect(dist.retriedJobs).toBe(2); // the 4 and the 2 (not the 0 or the 1)
    expect(dist.maxAttempts).toBe(4);
    expect(dist.meanAttempts).toBe(7 / 4);
  });

  it("clamps negative, fractional, and non-finite attempts to a sane count", () => {
    const dist = computeAttemptDistribution([
      job({ attempts: -3 }),
      job({ attempts: 2.9 }),
      job({ attempts: Number.NaN }),
      job({ attempts: Number.POSITIVE_INFINITY }),
    ]);
    // -3, NaN, and Infinity all normalize to 0; 2.9 floors to 2.
    expect(dist.buckets.map((b) => b.attempts)).toEqual([0, 2]);
    expect(dist.buckets.find((b) => b.attempts === 0)?.count).toBe(3);
    expect(dist.buckets.find((b) => b.attempts === 2)?.count).toBe(1);
    expect(dist.totalAttempts).toBe(2);
    expect(dist.maxAttempts).toBe(2);
    expect(dist.retriedJobs).toBe(1); // only the floored-to-2 job
  });

  it("counts a single-bucket store correctly", () => {
    const dist = computeAttemptDistribution([job({ attempts: 1 }), job({ attempts: 1 }), job({ attempts: 1 })]);
    expect(dist.buckets).toHaveLength(1);
    expect(dist.buckets[0]).toEqual({ attempts: 1, count: 3, active: 0, terminal: 3 });
    expect(dist.meanAttempts).toBe(1);
    expect(dist.retriedJobs).toBe(0);
  });
});
