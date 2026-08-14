import { describe, expect, it } from "vitest";
import { buildRecentReport } from "./recent.js";
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

const NOW = Date.parse("2026-07-30T12:00:00.000Z");

describe("buildRecentReport", () => {
  it("returns an empty report when nothing has finished", () => {
    const report = buildRecentReport([], NOW);
    expect(report).toEqual({ entries: [], totalResolved: 0, hidden: 0, avgResolutionMs: null });
  });

  it("ignores active jobs, keeping only terminal ones", () => {
    const report = buildRecentReport(
      [
        job({ status: "queued" }),
        job({ status: "waiting_for_reset", resetAt: "2026-07-30T13:00:00.000Z" }),
        job({ status: "resuming" }),
        job({ status: "completed" }),
        job({ status: "failed" }),
        job({ status: "cancelled" }),
      ],
      NOW
    );
    expect(report.totalResolved).toBe(3);
    expect(report.entries.map((e) => e.job.status).sort()).toEqual(["cancelled", "completed", "failed"]);
  });

  it("orders newest finished first (updatedAt desc)", () => {
    const older = job({ id: "older", updatedAt: "2026-07-30T02:00:00.000Z" });
    const newer = job({ id: "newer", updatedAt: "2026-07-30T09:00:00.000Z" });
    const middle = job({ id: "middle", updatedAt: "2026-07-30T05:00:00.000Z" });
    const report = buildRecentReport([older, newer, middle], NOW);
    expect(report.entries.map((e) => e.job.id)).toEqual(["newer", "middle", "older"]);
    expect(report.entries.map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it("breaks finish-time ties by newest createdAt then id (deterministic)", () => {
    const sameFinish = "2026-07-30T06:00:00.000Z";
    const a = job({ id: "a", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: sameFinish });
    const b = job({ id: "b", createdAt: "2026-07-30T01:00:00.000Z", updatedAt: sameFinish });
    const report = buildRecentReport([a, b], NOW);
    // b was created later → sorts first; ids only tie-break equal createdAt.
    expect(report.entries.map((e) => e.job.id)).toEqual(["b", "a"]);
  });

  it("computes resolution span and finished-ago for each entry", () => {
    const j = job({ createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T01:30:00.000Z" });
    const report = buildRecentReport([j], NOW);
    expect(report.entries[0].resolutionMs).toBe(90 * 60 * 1000); // 1h30m
    expect(report.entries[0].finishedAgoMs).toBe(
      Date.parse("2026-07-30T12:00:00.000Z") - Date.parse("2026-07-30T01:30:00.000Z")
    );
  });

  it("clamps finished-ago to zero for a future updatedAt (clock skew)", () => {
    const j = job({ updatedAt: "2026-07-30T20:00:00.000Z" });
    const report = buildRecentReport([j], NOW);
    expect(report.entries[0].finishedAgoMs).toBe(0);
  });

  it("reports a null span for missing/unparseable or negative-span timestamps", () => {
    const skewed = job({ createdAt: "2026-07-30T05:00:00.000Z", updatedAt: "2026-07-30T04:00:00.000Z" });
    const bad = job({ updatedAt: "not-a-date" });
    const report = buildRecentReport([skewed, bad], NOW);
    expect(report.entries.every((e) => e.resolutionMs === null)).toBe(true);
  });

  it("averages only well-formed spans across the full set", () => {
    const one = job({ createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T01:00:00.000Z" }); // 1h
    const three = job({ createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T03:00:00.000Z" }); // 3h
    const skewed = job({ createdAt: "2026-07-30T05:00:00.000Z", updatedAt: "2026-07-30T04:00:00.000Z" }); // null
    const report = buildRecentReport([one, three, skewed], NOW);
    expect(report.avgResolutionMs).toBe(2 * 60 * 60 * 1000); // avg of 1h and 3h = 2h
  });

  it("trims to limit but keeps totals and average honest", () => {
    const jobs = [
      job({ id: "j1", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T09:00:00.000Z" }),
      job({ id: "j2", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T08:00:00.000Z" }),
      job({ id: "j3", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T07:00:00.000Z" }),
    ];
    const report = buildRecentReport(jobs, NOW, 1);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].job.id).toBe("j1"); // newest finish
    expect(report.totalResolved).toBe(3);
    expect(report.hidden).toBe(2);
    // Average still spans all three (9h + 8h + 7h) / 3 = 8h.
    expect(report.avgResolutionMs).toBe(8 * 60 * 60 * 1000);
  });

  it("does not mutate the input array", () => {
    const jobs = [
      job({ id: "x", updatedAt: "2026-07-30T02:00:00.000Z" }),
      job({ id: "y", updatedAt: "2026-07-30T09:00:00.000Z" }),
    ];
    const snapshot = jobs.map((j) => j.id);
    buildRecentReport(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(snapshot);
  });

  it("sinks jobs with unparseable finish times to the bottom", () => {
    const good = job({ id: "good", updatedAt: "2026-07-30T05:00:00.000Z" });
    const bad = job({ id: "bad", updatedAt: "nope" });
    const report = buildRecentReport([bad, good], NOW);
    expect(report.entries.map((e) => e.job.id)).toEqual(["good", "bad"]);
  });
});
