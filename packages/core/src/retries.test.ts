import { describe, expect, it } from "vitest";
import { buildRetriesReport, DEFAULT_RETRIES_MIN_ATTEMPTS } from "./retries.js";
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
    resetAt: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("buildRetriesReport", () => {
  it("returns an empty report when nothing has been retried", () => {
    const report = buildRetriesReport([job({ attempts: 1 }), job({ attempts: 1 })]);
    expect(report).toEqual({
      entries: [],
      totalRetried: 0,
      hidden: 0,
      minAttempts: DEFAULT_RETRIES_MIN_ATTEMPTS,
      totalAttempts: 0,
      maxAttempts: 0,
    });
  });

  it("excludes single-attempt jobs by default (floor of 2)", () => {
    const report = buildRetriesReport([
      job({ id: "once", attempts: 1 }),
      job({ id: "twice", attempts: 2 }),
      job({ id: "thrice", attempts: 3 }),
    ]);
    expect(report.entries.map((e) => e.job.id)).toEqual(["thrice", "twice"]);
    expect(report.totalRetried).toBe(2);
  });

  it("ranks by attempt count desc and numbers positions from 1", () => {
    const report = buildRetriesReport([
      job({ id: "mid", attempts: 3 }),
      job({ id: "worst", attempts: 7 }),
      job({ id: "low", attempts: 2 }),
    ]);
    expect(report.entries.map((e) => e.job.id)).toEqual(["worst", "mid", "low"]);
    expect(report.entries.map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it("breaks ties deterministically by createdAt then id", () => {
    const report = buildRetriesReport([
      job({ id: "b", attempts: 4, createdAt: "2026-07-30T02:00:00.000Z" }),
      job({ id: "a", attempts: 4, createdAt: "2026-07-30T02:00:00.000Z" }),
      job({ id: "c", attempts: 4, createdAt: "2026-07-30T01:00:00.000Z" }),
    ]);
    expect(report.entries.map((e) => e.job.id)).toEqual(["c", "a", "b"]);
  });

  it("honors a custom minAttempts floor", () => {
    const jobs = [job({ id: "j2", attempts: 2 }), job({ id: "j5", attempts: 5 })];
    expect(buildRetriesReport(jobs, { minAttempts: 5 }).entries.map((e) => e.job.id)).toEqual(["j5"]);
    expect(buildRetriesReport(jobs, { minAttempts: 2 }).totalRetried).toBe(2);
  });

  it("clamps a below-1 or non-integer minAttempts to the default", () => {
    const jobs = [job({ id: "once", attempts: 1 }), job({ id: "twice", attempts: 2 })];
    // A floor of 0 would list the single-run job; it must fall back to the default 2.
    expect(buildRetriesReport(jobs, { minAttempts: 0 }).minAttempts).toBe(DEFAULT_RETRIES_MIN_ATTEMPTS);
    expect(buildRetriesReport(jobs, { minAttempts: -3 }).minAttempts).toBe(DEFAULT_RETRIES_MIN_ATTEMPTS);
    expect(buildRetriesReport(jobs, { minAttempts: 1.5 }).minAttempts).toBe(DEFAULT_RETRIES_MIN_ATTEMPTS);
    // ...and the default floor excludes the single-run job.
    expect(buildRetriesReport(jobs, { minAttempts: 0 }).entries.map((e) => e.job.id)).toEqual(["twice"]);
  });

  it("allows an explicit minAttempts of 1 to include every job", () => {
    const report = buildRetriesReport([job({ attempts: 1 }), job({ attempts: 3 })], { minAttempts: 1 });
    expect(report.totalRetried).toBe(2);
    expect(report.minAttempts).toBe(1);
  });

  it("computes totalAttempts and maxAttempts over the qualifying set", () => {
    const report = buildRetriesReport([
      job({ attempts: 1 }), // excluded
      job({ attempts: 2 }),
      job({ attempts: 5 }),
    ]);
    expect(report.totalAttempts).toBe(7); // 2 + 5, not the excluded 1
    expect(report.maxAttempts).toBe(5);
  });

  it("trims to the limit while keeping totals honest", () => {
    const report = buildRetriesReport(
      [
        job({ id: "j1", attempts: 2 }),
        job({ id: "j2", attempts: 3 }),
        job({ id: "j3", attempts: 4 }),
        job({ id: "j4", attempts: 5 }),
      ],
      { limit: 2 }
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["j4", "j3"]);
    expect(report.totalRetried).toBe(4);
    expect(report.hidden).toBe(2);
    expect(report.totalAttempts).toBe(14); // 2+3+4+5, not just the shown rows
    expect(report.maxAttempts).toBe(5);
  });

  it("does not mutate the input array order", () => {
    const jobs = [job({ id: "low", attempts: 2 }), job({ id: "high", attempts: 9 })];
    buildRetriesReport(jobs);
    expect(jobs.map((j) => j.id)).toEqual(["low", "high"]);
  });
});
