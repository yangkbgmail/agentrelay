import { describe, expect, it } from "vitest";
import { buildStuckReport, DEFAULT_STUCK_THRESHOLD_MS, TRANSIENT_STATUSES } from "./stuck.js";
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
    status: "resuming",
    resetAt: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-30T10:00:00.000Z");
const MIN = 60 * 1000;

describe("buildStuckReport", () => {
  it("returns an empty report when nothing is stuck", () => {
    const report = buildStuckReport([], NOW);
    expect(report).toEqual({
      entries: [],
      totalStuck: 0,
      hidden: 0,
      thresholdMs: DEFAULT_STUCK_THRESHOLD_MS,
      maxIdleMs: 0,
      statuses: ["queued", "resuming"],
    });
  });

  it("flags a resuming job idle past the threshold", () => {
    const report = buildStuckReport([job({ id: "orphan", updatedAt: "2026-07-30T09:00:00.000Z" })], NOW);
    expect(report.totalStuck).toBe(1);
    expect(report.entries[0].job.id).toBe("orphan");
    expect(report.entries[0].idleMs).toBe(60 * MIN);
  });

  it("flags a queued job idle past the threshold", () => {
    const report = buildStuckReport([job({ status: "queued", updatedAt: "2026-07-30T09:30:00.000Z" })], NOW);
    expect(report.totalStuck).toBe(1);
    expect(report.entries[0].idleMs).toBe(30 * MIN);
  });

  it("ignores transient jobs still within the threshold", () => {
    // Touched 5m ago — under the default 15m window.
    const report = buildStuckReport([job({ updatedAt: "2026-07-30T09:55:00.000Z" })], NOW);
    expect(report.totalStuck).toBe(0);
  });

  it("never flags resting states (waiting/completed/failed/cancelled), however old", () => {
    const ancient = "2026-07-01T00:00:00.000Z";
    const report = buildStuckReport(
      [
        job({ status: "waiting_for_reset", resetAt: "2026-08-01T00:00:00.000Z", updatedAt: ancient }),
        job({ status: "completed", updatedAt: ancient }),
        job({ status: "failed", updatedAt: ancient }),
        job({ status: "cancelled", updatedAt: ancient }),
      ],
      NOW
    );
    expect(report.totalStuck).toBe(0);
  });

  it("ranks most-idle first, breaking ties by createdAt then id", () => {
    const report = buildStuckReport(
      [
        job({ id: "b", updatedAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "a", updatedAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
        job({ id: "worst", updatedAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["worst", "a", "b"]);
    expect(report.maxIdleMs).toBe(120 * MIN);
  });

  it("honours a custom threshold", () => {
    const jobs = [job({ updatedAt: "2026-07-30T09:50:00.000Z" })]; // idle 10m
    expect(buildStuckReport(jobs, NOW, { thresholdMs: 5 * MIN }).totalStuck).toBe(1);
    expect(buildStuckReport(jobs, NOW, { thresholdMs: 20 * MIN }).totalStuck).toBe(0);
  });

  it("falls back to the default threshold for negative/non-finite values", () => {
    const jobs = [job({ updatedAt: "2026-07-30T09:40:00.000Z" })]; // idle 20m > default 15m
    expect(buildStuckReport(jobs, NOW, { thresholdMs: -1 }).thresholdMs).toBe(DEFAULT_STUCK_THRESHOLD_MS);
    expect(buildStuckReport(jobs, NOW, { thresholdMs: Number.NaN }).totalStuck).toBe(1);
  });

  it("trims to limit but keeps honest totals and maxIdleMs", () => {
    const jobs = [
      job({ id: "j1", updatedAt: "2026-07-30T08:00:00.000Z" }),
      job({ id: "j2", updatedAt: "2026-07-30T08:30:00.000Z" }),
      job({ id: "j3", updatedAt: "2026-07-30T09:00:00.000Z" }),
    ];
    const report = buildStuckReport(jobs, NOW, { limit: 1 });
    expect(report.entries.map((e) => e.job.id)).toEqual(["j1"]);
    expect(report.totalStuck).toBe(3);
    expect(report.hidden).toBe(2);
    expect(report.maxIdleMs).toBe(120 * MIN);
  });

  it("skips jobs with an unparseable updatedAt rather than throwing", () => {
    const report = buildStuckReport([job({ updatedAt: "not-a-date" })], NOW);
    expect(report.totalStuck).toBe(0);
  });

  it("respects a status override and falls back when it is empty/unknown", () => {
    const jobs = [
      job({ status: "queued", updatedAt: "2026-07-30T08:00:00.000Z" }),
      job({ status: "resuming", updatedAt: "2026-07-30T08:00:00.000Z" }),
    ];
    const onlyQueued = buildStuckReport(jobs, NOW, { statuses: ["queued"] });
    expect(onlyQueued.statuses).toEqual(["queued"]);
    expect(onlyQueued.entries.map((e) => e.job.status)).toEqual(["queued"]);

    // An override with no valid transient status falls back to the full set.
    const fellBack = buildStuckReport(jobs, NOW, { statuses: ["completed"] });
    expect(fellBack.statuses).toEqual(["queued", "resuming"]);
    expect(fellBack.totalStuck).toBe(2);
  });

  it("exposes the default transient set", () => {
    expect(TRANSIENT_STATUSES).toEqual(["queued", "resuming"]);
  });
});
