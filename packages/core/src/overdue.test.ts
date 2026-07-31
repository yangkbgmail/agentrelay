import { describe, expect, it } from "vitest";
import { buildOverdueReport, DEFAULT_OVERDUE_GRACE_MS, DEFAULT_RESUMING_STALE_MS } from "./overdue.js";
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
    resetAt: "2026-07-30T12:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-30T12:30:00.000Z");

describe("buildOverdueReport", () => {
  it("returns an empty, healthy report for no jobs", () => {
    const report = buildOverdueReport([], NOW);
    expect(report).toEqual({
      entries: [],
      waitingCount: 0,
      resumingCount: 0,
      total: 0,
      graceMs: DEFAULT_OVERDUE_GRACE_MS,
      staleMs: DEFAULT_RESUMING_STALE_MS,
    });
  });

  it("flags a waiting job whose reset passed beyond the grace window", () => {
    // reset at 12:00, now 12:30 → 30 min overdue, well past the 1-min grace.
    const report = buildOverdueReport([job({ id: "late", resetAt: "2026-07-30T12:00:00.000Z" })], NOW);
    expect(report.total).toBe(1);
    expect(report.waitingCount).toBe(1);
    expect(report.entries[0]).toMatchObject({
      kind: "waiting",
      overdueByMs: 30 * 60_000,
      referenceAt: "2026-07-30T12:00:00.000Z",
    });
    expect(report.entries[0].job.id).toBe("late");
  });

  it("does not flag a waiting job still within the grace window", () => {
    // reset 30s before now, default grace is 60s → not yet overdue.
    const reset = new Date(NOW - 30_000).toISOString();
    const report = buildOverdueReport([job({ resetAt: reset })], NOW);
    expect(report.total).toBe(0);
  });

  it("does not flag a waiting job whose reset is still in the future", () => {
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T18:00:00.000Z" })], NOW);
    expect(report.total).toBe(0);
  });

  it("skips waiting jobs with a null or unparseable resetAt", () => {
    const report = buildOverdueReport(
      [job({ id: "no-reset", resetAt: null }), job({ id: "bad", resetAt: "not a date" })],
      NOW
    );
    expect(report.total).toBe(0);
  });

  it("flags a resuming job stuck longer than the stale window", () => {
    // updated at 12:00, now 12:30 → 30 min in resuming, past the 5-min stale window.
    const report = buildOverdueReport(
      [job({ id: "stuck", status: "resuming", resetAt: null, updatedAt: "2026-07-30T12:00:00.000Z" })],
      NOW
    );
    expect(report.total).toBe(1);
    expect(report.resumingCount).toBe(1);
    expect(report.entries[0]).toMatchObject({
      kind: "resuming",
      overdueByMs: 30 * 60_000,
      referenceAt: "2026-07-30T12:00:00.000Z",
    });
  });

  it("does not flag a resuming job updated within the stale window", () => {
    const updated = new Date(NOW - 60_000).toISOString(); // 1 min ago, default stale 5 min
    const report = buildOverdueReport([job({ status: "resuming", resetAt: null, updatedAt: updated })], NOW);
    expect(report.total).toBe(0);
  });

  it("never flags queued or terminal jobs", () => {
    const old = "2026-07-01T00:00:00.000Z";
    const report = buildOverdueReport(
      [
        job({ status: "queued", resetAt: old, updatedAt: old }),
        job({ status: "completed", resetAt: old, updatedAt: old }),
        job({ status: "failed", resetAt: old, updatedAt: old }),
        job({ status: "cancelled", resetAt: old, updatedAt: old }),
      ],
      NOW
    );
    expect(report.total).toBe(0);
  });

  it("orders entries worst-first and counts both kinds", () => {
    const report = buildOverdueReport(
      [
        job({ id: "waiting-a-bit", resetAt: "2026-07-30T12:20:00.000Z" }), // 10 min late
        job({ id: "waiting-a-lot", resetAt: "2026-07-30T11:00:00.000Z" }), // 90 min late
        job({ id: "stuck", status: "resuming", resetAt: null, updatedAt: "2026-07-30T12:10:00.000Z" }), // 20 min
      ],
      NOW
    );
    expect(report.total).toBe(3);
    expect(report.waitingCount).toBe(2);
    expect(report.resumingCount).toBe(1);
    expect(report.entries.map((e) => e.job.id)).toEqual(["waiting-a-lot", "stuck", "waiting-a-bit"]);
  });

  it("breaks ties by createdAt then id deterministically", () => {
    const report = buildOverdueReport(
      [
        job({ id: "b", resetAt: "2026-07-30T12:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
        job({ id: "a", resetAt: "2026-07-30T12:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
      ],
      NOW
    );
    // Equal overdueByMs and createdAt → id ascending.
    expect(report.entries.map((e) => e.job.id)).toEqual(["a", "b"]);
  });

  it("honours custom grace and stale thresholds", () => {
    const jobs = [
      job({ id: "w", resetAt: "2026-07-30T12:20:00.000Z" }), // 10 min late
      job({ id: "r", status: "resuming", resetAt: null, updatedAt: "2026-07-30T12:20:00.000Z" }), // 10 min
    ];
    // Grace 15 min and stale 15 min → neither is overdue yet.
    const relaxed = buildOverdueReport(jobs, NOW, { graceMs: 15 * 60_000, staleMs: 15 * 60_000 });
    expect(relaxed.total).toBe(0);
    expect(relaxed.graceMs).toBe(15 * 60_000);
    expect(relaxed.staleMs).toBe(15 * 60_000);
    // Tighten both to 5 min → both overdue.
    const strict = buildOverdueReport(jobs, NOW, { graceMs: 5 * 60_000, staleMs: 5 * 60_000 });
    expect(strict.total).toBe(2);
  });
});
