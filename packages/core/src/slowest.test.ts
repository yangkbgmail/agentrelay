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
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const HOUR = 60 * 60 * 1000;

/** Build a terminal job whose lifecycle span is exactly `spanMs`. */
function resolved(spanMs: number, overrides: Partial<RelayJob> = {}): RelayJob {
  const created = Date.parse("2026-08-01T00:00:00.000Z");
  return job({
    createdAt: new Date(created).toISOString(),
    updatedAt: new Date(created + spanMs).toISOString(),
    ...overrides,
  });
}

describe("buildSlowestReport", () => {
  it("returns an empty report for no jobs", () => {
    const report = buildSlowestReport([]);
    expect(report.entries).toEqual([]);
    expect(report.totalResolved).toBe(0);
    expect(report.hidden).toBe(0);
    expect(report.maxResolutionMs).toBe(0);
    expect(report.totalResolutionMs).toBe(0);
  });

  it("ranks resolved jobs slowest-first", () => {
    const jobs = [resolved(HOUR), resolved(3 * HOUR), resolved(2 * HOUR)];
    const report = buildSlowestReport(jobs);
    expect(report.entries.map((e) => e.resolutionMs)).toEqual([3 * HOUR, 2 * HOUR, HOUR]);
    expect(report.totalResolved).toBe(3);
    expect(report.maxResolutionMs).toBe(3 * HOUR);
    expect(report.totalResolutionMs).toBe(6 * HOUR);
    expect(report.hidden).toBe(0);
  });

  it("counts failed jobs too (both terminal states resolve)", () => {
    const jobs = [resolved(HOUR, { status: "failed" }), resolved(2 * HOUR, { status: "completed" })];
    const report = buildSlowestReport(jobs);
    expect(report.totalResolved).toBe(2);
    expect(report.entries[0].resolutionMs).toBe(2 * HOUR);
  });

  it("excludes active jobs (queued/waiting/resuming) and cancelled", () => {
    const jobs = [
      resolved(5 * HOUR, { status: "queued" }),
      resolved(4 * HOUR, { status: "waiting_for_reset" }),
      resolved(3 * HOUR, { status: "resuming" }),
      resolved(2 * HOUR, { status: "cancelled" }),
      resolved(HOUR, { status: "completed" }),
    ];
    const report = buildSlowestReport(jobs);
    expect(report.totalResolved).toBe(1);
    expect(report.entries[0].resolutionMs).toBe(HOUR);
  });

  it("skips unparseable timestamps and negative (clock-skew) spans", () => {
    const bad = job({ createdAt: "not-a-date", updatedAt: "2026-08-01T01:00:00.000Z" });
    const skew = job({ createdAt: "2026-08-01T02:00:00.000Z", updatedAt: "2026-08-01T01:00:00.000Z" });
    const good = resolved(HOUR);
    const report = buildSlowestReport([bad, skew, good]);
    expect(report.totalResolved).toBe(1);
    expect(report.entries[0].job.id).toBe(good.id);
  });

  it("keeps a zero-length span (instant resolution) as resolved", () => {
    const report = buildSlowestReport([resolved(0)]);
    expect(report.totalResolved).toBe(1);
    expect(report.entries[0].resolutionMs).toBe(0);
    expect(report.maxResolutionMs).toBe(0);
  });

  it("trims to limit but totals still count the full set", () => {
    const jobs = [resolved(HOUR), resolved(2 * HOUR), resolved(3 * HOUR), resolved(4 * HOUR)];
    const report = buildSlowestReport(jobs, { limit: 2 });
    expect(report.entries.map((e) => e.resolutionMs)).toEqual([4 * HOUR, 3 * HOUR]);
    expect(report.totalResolved).toBe(4);
    expect(report.hidden).toBe(2);
    expect(report.maxResolutionMs).toBe(4 * HOUR);
    expect(report.totalResolutionMs).toBe(10 * HOUR);
  });

  it("ignores a non-integer or negative limit (shows all)", () => {
    const jobs = [resolved(HOUR), resolved(2 * HOUR)];
    expect(buildSlowestReport(jobs, { limit: 1.5 }).entries).toHaveLength(2);
    expect(buildSlowestReport(jobs, { limit: -1 }).entries).toHaveLength(2);
  });

  it("limit 0 hides every row while totals stand", () => {
    const report = buildSlowestReport([resolved(HOUR), resolved(2 * HOUR)], { limit: 0 });
    expect(report.entries).toEqual([]);
    expect(report.totalResolved).toBe(2);
    expect(report.hidden).toBe(2);
  });

  it("breaks span ties deterministically by createdAt then id", () => {
    const created = Date.parse("2026-08-01T00:00:00.000Z");
    const older = job({
      id: "b",
      createdAt: new Date(created).toISOString(),
      updatedAt: new Date(created + HOUR).toISOString(),
    });
    const newer = job({
      id: "a",
      createdAt: new Date(created + 5 * HOUR).toISOString(),
      updatedAt: new Date(created + 6 * HOUR).toISOString(),
    });
    // Both spans are exactly HOUR; older createdAt should rank first.
    const report = buildSlowestReport([newer, older]);
    expect(report.entries.map((e) => e.job.id)).toEqual(["b", "a"]);
  });

  it("does not mutate the input array", () => {
    const jobs = [resolved(HOUR), resolved(3 * HOUR), resolved(2 * HOUR)];
    const snapshot = jobs.map((j) => j.id);
    buildSlowestReport(jobs);
    expect(jobs.map((j) => j.id)).toEqual(snapshot);
  });
});
