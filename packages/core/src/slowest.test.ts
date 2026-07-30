import { describe, expect, it } from "vitest";
import { computeSlowest } from "./slowest.js";
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
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T01:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const HOUR = 60 * 60 * 1000;

describe("computeSlowest", () => {
  it("returns an empty report when nothing has resolved", () => {
    const report = computeSlowest([]);
    expect(report).toEqual({ entries: [], totalResolved: 0, hidden: 0 });
  });

  it("only ranks resolved (completed/failed) jobs, ignoring active and cancelled ones", () => {
    const report = computeSlowest([
      job({ id: "done", status: "completed" }),
      job({ id: "failed", status: "failed" }),
      job({ id: "cancelled", status: "cancelled" }),
      job({ id: "queued", status: "queued" }),
      job({ id: "waiting", status: "waiting_for_reset", resetAt: "2026-07-30T05:00:00.000Z" }),
      job({ id: "resuming", status: "resuming" }),
    ]);
    expect(report.totalResolved).toBe(2);
    expect(report.entries.map((e) => e.job.id).sort()).toEqual(["done", "failed"]);
  });

  it("ranks slowest first and numbers ranks from 1", () => {
    const report = computeSlowest([
      job({ id: "fast", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T00:30:00.000Z" }),
      job({ id: "slow", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T04:00:00.000Z" }),
      job({ id: "mid", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T02:00:00.000Z" }),
    ]);
    expect(report.entries.map((e) => e.job.id)).toEqual(["slow", "mid", "fast"]);
    expect(report.entries.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(report.entries[0].resolutionMs).toBe(4 * HOUR);
  });

  it("skips jobs with unparseable timestamps or negative (clock-skew) spans", () => {
    const report = computeSlowest([
      job({ id: "good", updatedAt: "2026-07-30T02:00:00.000Z" }),
      job({ id: "bad-created", createdAt: "not a date" }),
      job({ id: "bad-updated", updatedAt: "nope" }),
      job({ id: "negative", createdAt: "2026-07-30T02:00:00.000Z", updatedAt: "2026-07-30T00:00:00.000Z" }),
    ]);
    expect(report.totalResolved).toBe(1);
    expect(report.entries.map((e) => e.job.id)).toEqual(["good"]);
  });

  it("counts a zero-length span as resolved", () => {
    const report = computeSlowest([
      job({ id: "instant", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T00:00:00.000Z" }),
    ]);
    expect(report.totalResolved).toBe(1);
    expect(report.entries[0].resolutionMs).toBe(0);
  });

  it("breaks span ties deterministically by newest updatedAt then id", () => {
    const report = computeSlowest([
      // All three share the same 1h span; tie-break: newer updatedAt first, then id asc.
      job({ id: "b", createdAt: "2026-07-30T01:00:00.000Z", updatedAt: "2026-07-30T02:00:00.000Z" }),
      job({ id: "a", createdAt: "2026-07-30T01:00:00.000Z", updatedAt: "2026-07-30T02:00:00.000Z" }),
      job({ id: "newer", createdAt: "2026-07-30T02:00:00.000Z", updatedAt: "2026-07-30T03:00:00.000Z" }),
    ]);
    expect(report.entries.map((e) => e.job.id)).toEqual(["newer", "a", "b"]);
  });

  it("trims to the limit while keeping totalResolved honest", () => {
    const report = computeSlowest(
      [
        job({ id: "j1", updatedAt: "2026-07-30T04:00:00.000Z" }),
        job({ id: "j2", updatedAt: "2026-07-30T03:00:00.000Z" }),
        job({ id: "j3", updatedAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "j4", updatedAt: "2026-07-30T01:30:00.000Z" }),
      ],
      2
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["j1", "j2"]);
    expect(report.totalResolved).toBe(4);
    expect(report.hidden).toBe(2);
  });

  it("ignores a non-positive or non-integer limit and ranks everything", () => {
    const jobs = [
      job({ id: "j1", updatedAt: "2026-07-30T04:00:00.000Z" }),
      job({ id: "j2", updatedAt: "2026-07-30T03:00:00.000Z" }),
    ];
    expect(computeSlowest(jobs, 0).entries).toHaveLength(0);
    expect(computeSlowest(jobs, 1.5).entries).toHaveLength(2);
    expect(computeSlowest(jobs, undefined).entries).toHaveLength(2);
  });

  it("does not mutate the input array order", () => {
    const jobs = [
      job({ id: "fast", updatedAt: "2026-07-30T00:30:00.000Z" }),
      job({ id: "slow", updatedAt: "2026-07-30T04:00:00.000Z" }),
    ];
    computeSlowest(jobs);
    expect(jobs.map((j) => j.id)).toEqual(["fast", "slow"]);
  });
});
