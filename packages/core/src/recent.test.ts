import { describe, expect, it } from "vitest";
import { buildRecentReport, isRecentTerminalStatus } from "./recent.js";
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
    updatedAt: "2026-07-30T09:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-30T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describe("buildRecentReport", () => {
  it("returns an empty report for an empty store", () => {
    const report = buildRecentReport([], NOW);
    expect(report).toEqual({
      entries: [],
      totalTerminal: 0,
      hidden: 0,
      byOutcome: { completed: 0, failed: 0, cancelled: 0 },
      withinMs: null,
    });
  });

  it("includes only terminal jobs (completed/failed/cancelled)", () => {
    const report = buildRecentReport(
      [
        job({ id: "done", status: "completed" }),
        job({ id: "err", status: "failed" }),
        job({ id: "gone", status: "cancelled" }),
        job({ id: "wait", status: "waiting_for_reset" }),
        job({ id: "q", status: "queued" }),
        job({ id: "run", status: "resuming" }),
      ],
      NOW
    );
    expect(report.totalTerminal).toBe(3);
    expect(report.entries.map((e) => e.job.id).sort()).toEqual(["done", "err", "gone"]);
    expect(report.byOutcome).toEqual({ completed: 1, failed: 1, cancelled: 1 });
  });

  it("orders most-recently-resolved first (by updatedAt desc)", () => {
    const report = buildRecentReport(
      [
        job({ id: "old", updatedAt: "2026-07-30T07:00:00.000Z" }),
        job({ id: "new", updatedAt: "2026-07-30T09:30:00.000Z" }),
        job({ id: "mid", updatedAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["new", "mid", "old"]);
  });

  it("tie-breaks equal updatedAt by newest createdAt then id asc", () => {
    const report = buildRecentReport(
      [
        job({ id: "b", updatedAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
        job({ id: "a", updatedAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
        job({ id: "younger", updatedAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T05:00:00.000Z" }),
      ],
      NOW
    );
    // Newer createdAt first, then id asc for the two identical creations.
    expect(report.entries.map((e) => e.job.id)).toEqual(["younger", "a", "b"]);
  });

  it("computes ageMs (now - resolvedAt) and resolutionMs (updatedAt - createdAt)", () => {
    const report = buildRecentReport(
      [job({ id: "x", createdAt: "2026-07-30T08:00:00.000Z", updatedAt: "2026-07-30T09:00:00.000Z" })],
      NOW
    );
    const [entry] = report.entries;
    expect(entry.resolvedAt).toBe(Date.parse("2026-07-30T09:00:00.000Z"));
    expect(entry.ageMs).toBe(HOUR); // resolved 1h before NOW
    expect(entry.resolutionMs).toBe(HOUR); // took 1h from creation
  });

  it("clamps ageMs to 0 for a future updatedAt (clock skew) and yields null resolutionMs on negative span", () => {
    const report = buildRecentReport(
      [job({ id: "future", createdAt: "2026-07-30T12:00:00.000Z", updatedAt: "2026-07-30T11:00:00.000Z" })],
      NOW
    );
    const [entry] = report.entries;
    expect(entry.ageMs).toBe(0); // updatedAt is after NOW → clamped
    expect(entry.resolutionMs).toBeNull(); // updatedAt < createdAt → negative span
  });

  it("skips jobs with an unparseable updatedAt", () => {
    const report = buildRecentReport([job({ id: "ok" }), job({ id: "bad", updatedAt: "not-a-date" })], NOW);
    expect(report.entries.map((e) => e.job.id)).toEqual(["ok"]);
    expect(report.totalTerminal).toBe(1);
  });

  it("applies the withinMs resolution-age window", () => {
    const report = buildRecentReport(
      [
        job({ id: "recent", updatedAt: "2026-07-30T09:30:00.000Z" }), // 30m ago
        job({ id: "stale", updatedAt: "2026-07-30T06:00:00.000Z" }), // 4h ago
      ],
      NOW,
      { withinMs: HOUR }
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["recent"]);
    expect(report.totalTerminal).toBe(1);
    expect(report.withinMs).toBe(HOUR);
  });

  it("treats non-positive/non-finite withinMs as unbounded", () => {
    const jobs = [job({ id: "a", updatedAt: "2026-07-25T00:00:00.000Z" })];
    expect(buildRecentReport(jobs, NOW, { withinMs: 0 }).withinMs).toBeNull();
    expect(buildRecentReport(jobs, NOW, { withinMs: -5 }).withinMs).toBeNull();
    expect(buildRecentReport(jobs, NOW, { withinMs: Number.POSITIVE_INFINITY }).withinMs).toBeNull();
    expect(buildRecentReport(jobs, NOW, { withinMs: 0 }).totalTerminal).toBe(1);
  });

  it("trims entries to limit but keeps totals/byOutcome honest", () => {
    const report = buildRecentReport(
      [
        job({ id: "a", status: "completed", updatedAt: "2026-07-30T09:00:00.000Z" }),
        job({ id: "b", status: "failed", updatedAt: "2026-07-30T08:00:00.000Z" }),
        job({ id: "c", status: "cancelled", updatedAt: "2026-07-30T07:00:00.000Z" }),
      ],
      NOW,
      { limit: 1 }
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["a"]);
    expect(report.totalTerminal).toBe(3);
    expect(report.hidden).toBe(2);
    expect(report.byOutcome).toEqual({ completed: 1, failed: 1, cancelled: 1 });
  });

  it("does not mutate the input array", () => {
    const jobs = [
      job({ id: "old", updatedAt: "2026-07-30T07:00:00.000Z" }),
      job({ id: "new", updatedAt: "2026-07-30T09:00:00.000Z" }),
    ];
    const before = jobs.map((j) => j.id);
    buildRecentReport(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(before);
  });
});

describe("isRecentTerminalStatus", () => {
  it("is true for terminal statuses and false otherwise", () => {
    expect(isRecentTerminalStatus("completed")).toBe(true);
    expect(isRecentTerminalStatus("failed")).toBe(true);
    expect(isRecentTerminalStatus("cancelled")).toBe(true);
    expect(isRecentTerminalStatus("queued")).toBe(false);
    expect(isRecentTerminalStatus("waiting_for_reset")).toBe(false);
    expect(isRecentTerminalStatus("resuming")).toBe(false);
  });
});
