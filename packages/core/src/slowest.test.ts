import { describe, expect, it } from "vitest";
import { buildSlowestReport } from "./slowest.js";
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

describe("buildSlowestReport", () => {
  it("returns an empty report when there are no jobs", () => {
    expect(buildSlowestReport([])).toEqual({
      entries: [],
      totalResolved: 0,
      hidden: 0,
      maxResolutionMs: 0,
    });
  });

  it("only counts resolved jobs (completed + failed); ignores active and cancelled", () => {
    const report = buildSlowestReport([
      job({
        id: "done",
        status: "completed",
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T02:00:00.000Z",
      }),
      job({
        id: "fail",
        status: "failed",
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T01:00:00.000Z",
      }),
      job({ id: "queued", status: "queued" }),
      job({ id: "waiting", status: "waiting_for_reset" }),
      job({ id: "resuming", status: "resuming" }),
      job({ id: "cancelled", status: "cancelled" }),
    ]);
    expect(report.totalResolved).toBe(2);
    expect(report.entries.map((e) => e.job.id)).toEqual(["done", "fail"]);
  });

  it("ranks slowest first by lifecycle span", () => {
    const report = buildSlowestReport([
      job({ id: "short", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T00:30:00.000Z" }),
      job({ id: "long", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T05:00:00.000Z" }),
      job({ id: "mid", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T02:00:00.000Z" }),
    ]);
    expect(report.entries.map((e) => e.job.id)).toEqual(["long", "mid", "short"]);
    expect(report.entries.map((e) => e.resolutionMs)).toEqual([5 * HOUR, 2 * HOUR, 30 * 60 * 1000]);
    expect(report.maxResolutionMs).toBe(5 * HOUR);
  });

  it("breaks ties deterministically: newer updatedAt first, then id", () => {
    const report = buildSlowestReport([
      // both spans are exactly 1h
      job({ id: "b", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T01:00:00.000Z" }),
      job({ id: "a", createdAt: "2026-07-30T02:00:00.000Z", updatedAt: "2026-07-30T03:00:00.000Z" }),
      job({ id: "c", createdAt: "2026-07-30T02:00:00.000Z", updatedAt: "2026-07-30T03:00:00.000Z" }),
    ]);
    // "a" & "c" share the newest updatedAt (03:00) so they precede "b"; among
    // them id asc → a before c.
    expect(report.entries.map((e) => e.job.id)).toEqual(["a", "c", "b"]);
  });

  it("skips jobs with a missing/unparseable timestamp or a negative span", () => {
    const report = buildSlowestReport([
      job({ id: "ok", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T01:00:00.000Z" }),
      job({ id: "bad-updated", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "not-a-date" }),
      job({ id: "skew", createdAt: "2026-07-30T05:00:00.000Z", updatedAt: "2026-07-30T04:00:00.000Z" }),
    ]);
    expect(report.entries.map((e) => e.job.id)).toEqual(["ok"]);
    expect(report.totalResolved).toBe(1);
  });

  it("trims entries to limit but totals reflect the full set", () => {
    const jobs = [
      job({ id: "j1", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T04:00:00.000Z" }),
      job({ id: "j2", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T03:00:00.000Z" }),
      job({ id: "j3", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T02:00:00.000Z" }),
    ];
    const report = buildSlowestReport(jobs, { limit: 2 });
    expect(report.entries.map((e) => e.job.id)).toEqual(["j1", "j2"]);
    expect(report.totalResolved).toBe(3);
    expect(report.hidden).toBe(1);
    expect(report.maxResolutionMs).toBe(4 * HOUR);
  });

  it("does not mutate the input array", () => {
    const jobs = [
      job({ id: "x", updatedAt: "2026-07-30T00:30:00.000Z" }),
      job({ id: "y", updatedAt: "2026-07-30T05:00:00.000Z" }),
    ];
    const snapshot = jobs.map((j) => j.id);
    buildSlowestReport(jobs);
    expect(jobs.map((j) => j.id)).toEqual(snapshot);
  });
});
