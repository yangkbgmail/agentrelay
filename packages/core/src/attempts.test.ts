import { describe, expect, it } from "vitest";
import { summarizeAttempts } from "./attempts.js";
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

describe("summarizeAttempts", () => {
  it("returns an empty shape for no jobs", () => {
    expect(summarizeAttempts([])).toEqual({
      total: 0,
      totalAttempts: 0,
      retried: 0,
      neverAttempted: 0,
      maxAttempts: 0,
      ceiling: null,
      atCeiling: 0,
      buckets: [],
    });
  });

  it("buckets jobs by exact attempt count, sorted ascending", () => {
    const summary = summarizeAttempts([
      job({ id: "a", attempts: 0 }),
      job({ id: "b", attempts: 2 }),
      job({ id: "c", attempts: 1 }),
      job({ id: "d", attempts: 2 }),
    ]);
    expect(summary.buckets).toEqual([
      { attempts: 0, count: 1, jobIds: ["a"] },
      { attempts: 1, count: 1, jobIds: ["c"] },
      { attempts: 2, count: 2, jobIds: ["b", "d"] },
    ]);
  });

  it("preserves first-seen order of job ids within a bucket", () => {
    const summary = summarizeAttempts([
      job({ id: "z", attempts: 3 }),
      job({ id: "y", attempts: 3 }),
      job({ id: "x", attempts: 3 }),
    ]);
    expect(summary.buckets[0].jobIds).toEqual(["z", "y", "x"]);
  });

  it("computes totals, retried, neverAttempted, and maxAttempts", () => {
    const summary = summarizeAttempts([
      job({ attempts: 0 }),
      job({ attempts: 0 }),
      job({ attempts: 1 }),
      job({ attempts: 4 }),
    ]);
    expect(summary.total).toBe(4);
    expect(summary.totalAttempts).toBe(5);
    expect(summary.retried).toBe(1); // only the attempts=4 job is >= 2
    expect(summary.neverAttempted).toBe(2);
    expect(summary.maxAttempts).toBe(4);
  });

  it("counts jobs at or above a finite ceiling with the >= boundary", () => {
    const summary = summarizeAttempts(
      [job({ attempts: 3 }), job({ attempts: 5 }), job({ attempts: 6 }), job({ attempts: 1 })],
      { maxAttempts: 5 }
    );
    expect(summary.ceiling).toBe(5);
    expect(summary.atCeiling).toBe(2); // attempts 5 and 6, matching isRetryExhausted's >=
  });

  it("treats an unlimited ceiling (<= 0) as no ceiling", () => {
    const summary = summarizeAttempts([job({ attempts: 9 })], { maxAttempts: 0 });
    expect(summary.ceiling).toBeNull();
    expect(summary.atCeiling).toBe(0);
  });

  it("floors a fractional ceiling and leaves it null when omitted", () => {
    expect(summarizeAttempts([job({ attempts: 4 })], { maxAttempts: 4.9 }).ceiling).toBe(4);
    expect(summarizeAttempts([job({ attempts: 4 })]).ceiling).toBeNull();
  });

  it("clamps malformed attempts (negative / non-integer / NaN) to a clean integer >= 0", () => {
    const summary = summarizeAttempts([
      job({ id: "neg", attempts: -3 }),
      job({ id: "frac", attempts: 2.7 }),
      job({ id: "nan", attempts: Number.NaN }),
    ]);
    expect(summary.buckets).toEqual([
      { attempts: 0, count: 2, jobIds: ["neg", "nan"] },
      { attempts: 2, count: 1, jobIds: ["frac"] },
    ]);
    expect(summary.totalAttempts).toBe(2);
    expect(summary.neverAttempted).toBe(2);
  });

  it("does not mutate the input array", () => {
    const jobs = [job({ attempts: 2 }), job({ attempts: 0 })];
    const snapshot = jobs.map((j) => ({ ...j }));
    summarizeAttempts(jobs, { maxAttempts: 5 });
    expect(jobs).toEqual(snapshot);
  });
});
