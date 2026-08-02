import { describe, expect, it } from "vitest";
import { buildRecentActivity } from "./recent.js";
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

describe("buildRecentActivity", () => {
  it("returns an empty report for an empty store", () => {
    expect(buildRecentActivity([], NOW)).toEqual({ entries: [], total: 0, hidden: 0 });
  });

  it("includes only terminal jobs (completed/failed/cancelled), never active ones", () => {
    const report = buildRecentActivity(
      [
        job({ status: "completed" }),
        job({ status: "failed" }),
        job({ status: "cancelled" }),
        job({ status: "queued" }),
        job({ status: "waiting_for_reset" }),
        job({ status: "resuming" }),
      ],
      NOW
    );
    expect(report.total).toBe(3);
    expect(report.entries.map((e) => e.job.status).sort()).toEqual(["cancelled", "completed", "failed"]);
  });

  it("orders rows most-recently-updated first", () => {
    const report = buildRecentActivity(
      [
        job({ id: "old", updatedAt: "2026-07-30T06:00:00.000Z" }),
        job({ id: "new", updatedAt: "2026-07-30T09:30:00.000Z" }),
        job({ id: "mid", updatedAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["new", "mid", "old"]);
  });

  it("breaks updatedAt ties by newest createdAt, then id ascending", () => {
    const sameUpdate = "2026-07-30T09:00:00.000Z";
    const report = buildRecentActivity(
      [
        job({ id: "b", updatedAt: sameUpdate, createdAt: "2026-07-30T01:00:00.000Z" }),
        job({ id: "a", updatedAt: sameUpdate, createdAt: "2026-07-30T01:00:00.000Z" }),
        job({ id: "c", updatedAt: sameUpdate, createdAt: "2026-07-30T05:00:00.000Z" }),
      ],
      NOW
    );
    // newest createdAt first (c), then the two equal-createdAt jobs by id asc (a, b).
    expect(report.entries.map((e) => e.job.id)).toEqual(["c", "a", "b"]);
  });

  it("computes ageMs from updatedAt and resolutionMs from the lifecycle span", () => {
    const report = buildRecentActivity(
      [job({ createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T09:00:00.000Z" })],
      NOW
    );
    expect(report.entries[0].ageMs).toBe(HOUR); // 10:00 now − 09:00 updated
    expect(report.entries[0].resolutionMs).toBe(9 * HOUR); // 09:00 − 00:00
  });

  it("clamps a future updatedAt (clock skew) to ageMs 0 instead of going negative", () => {
    const report = buildRecentActivity([job({ updatedAt: "2026-07-30T11:00:00.000Z" })], NOW);
    expect(report.entries[0].ageMs).toBe(0);
  });

  it("skips (nulls) a negative resolution span rather than clamping it", () => {
    const report = buildRecentActivity(
      [job({ createdAt: "2026-07-30T09:00:00.000Z", updatedAt: "2026-07-30T08:00:00.000Z" })],
      NOW
    );
    expect(report.entries[0].resolutionMs).toBeNull();
  });

  it("tolerates an unparseable updatedAt: ageMs null, sorted to the back, no throw", () => {
    const report = buildRecentActivity(
      [job({ id: "bad", updatedAt: "not-a-date" }), job({ id: "good", updatedAt: "2026-07-30T09:00:00.000Z" })],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["good", "bad"]);
    const bad = report.entries.find((e) => e.job.id === "bad");
    expect(bad?.ageMs).toBeNull();
    expect(bad?.resolutionMs).toBeNull();
  });

  it("trims to limit but keeps total honest and reports hidden", () => {
    const report = buildRecentActivity(
      [
        job({ id: "j1", updatedAt: "2026-07-30T09:00:00.000Z" }),
        job({ id: "j2", updatedAt: "2026-07-30T08:00:00.000Z" }),
        job({ id: "j3", updatedAt: "2026-07-30T07:00:00.000Z" }),
      ],
      NOW,
      { limit: 2 }
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["j1", "j2"]);
    expect(report.total).toBe(3);
    expect(report.hidden).toBe(1);
  });

  it("treats limit 0 as show-nothing while still counting the total", () => {
    const report = buildRecentActivity([job(), job()], NOW, { limit: 0 });
    expect(report.entries).toEqual([]);
    expect(report.total).toBe(2);
    expect(report.hidden).toBe(2);
  });

  it("does not mutate the input array order", () => {
    const jobs = [
      job({ id: "x", updatedAt: "2026-07-30T06:00:00.000Z" }),
      job({ id: "y", updatedAt: "2026-07-30T09:00:00.000Z" }),
    ];
    buildRecentActivity(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(["x", "y"]);
  });
});
