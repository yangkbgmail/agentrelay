import { describe, expect, it } from "vitest";
import { findOverdueJobs } from "./overdue.js";
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
    resetAt: "2026-07-30T09:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-30T10:00:00.000Z");
const HOUR = 3_600_000;

describe("findOverdueJobs", () => {
  it("returns an empty report when nothing is overdue", () => {
    const report = findOverdueJobs([], NOW);
    expect(report).toEqual({
      entries: [],
      total: 0,
      worstLateByMs: 0,
      byReason: { resetPassed: 0, stuckResuming: 0 },
    });
  });

  it("flags a waiting job whose reset has passed", () => {
    const report = findOverdueJobs([job({ id: "late", resetAt: "2026-07-30T09:00:00.000Z" })], NOW);
    expect(report.total).toBe(1);
    expect(report.entries[0].job.id).toBe("late");
    expect(report.entries[0].reason).toBe("reset-passed");
    expect(report.entries[0].lateByMs).toBe(HOUR);
    expect(report.worstLateByMs).toBe(HOUR);
    expect(report.byReason).toEqual({ resetPassed: 1, stuckResuming: 0 });
  });

  it("does not flag a waiting job whose reset is still in the future", () => {
    const report = findOverdueJobs([job({ resetAt: "2026-07-30T11:00:00.000Z" })], NOW);
    expect(report.total).toBe(0);
  });

  it("respects the grace window — only past-due beyond grace counts", () => {
    // reset was 90s ago; grace of 2m should suppress it, 1m should surface it.
    const j = job({ resetAt: new Date(NOW - 90_000).toISOString() });
    expect(findOverdueJobs([j], NOW, { graceMs: 120_000 }).total).toBe(0);
    expect(findOverdueJobs([j], NOW, { graceMs: 60_000 }).total).toBe(1);
  });

  it("treats exactly-at-reset as not overdue (grace is strict >)", () => {
    const report = findOverdueJobs([job({ resetAt: new Date(NOW).toISOString() })], NOW);
    expect(report.total).toBe(0);
  });

  it("ignores waiting jobs with a missing or unparseable resetAt", () => {
    const report = findOverdueJobs(
      [job({ id: "no-reset", resetAt: null }), job({ id: "bad-reset", resetAt: "not-a-date" })],
      NOW
    );
    expect(report.total).toBe(0);
  });

  it("ignores non-waiting, non-resuming statuses", () => {
    const report = findOverdueJobs(
      [
        job({ status: "queued", resetAt: "2026-07-30T09:00:00.000Z" }),
        job({ status: "completed", resetAt: "2026-07-30T09:00:00.000Z" }),
        job({ status: "failed", resetAt: "2026-07-30T09:00:00.000Z" }),
        job({ status: "cancelled", resetAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.total).toBe(0);
  });

  it("does not check resuming jobs unless stuckResumingMs is provided", () => {
    const stuck = job({ status: "resuming", updatedAt: "2026-07-30T00:00:00.000Z", resetAt: null });
    expect(findOverdueJobs([stuck], NOW).total).toBe(0);
    const report = findOverdueJobs([stuck], NOW, { stuckResumingMs: HOUR });
    expect(report.total).toBe(1);
    expect(report.entries[0].reason).toBe("stuck-resuming");
    expect(report.entries[0].lateByMs).toBe(10 * HOUR);
    expect(report.byReason).toEqual({ resetPassed: 0, stuckResuming: 1 });
  });

  it("does not flag a resuming job that updated recently", () => {
    const fresh = job({ status: "resuming", updatedAt: new Date(NOW - 30_000).toISOString(), resetAt: null });
    expect(findOverdueJobs([fresh], NOW, { stuckResumingMs: 60_000 }).total).toBe(0);
  });

  it("sorts most-overdue first, mixing both reasons", () => {
    const report = findOverdueJobs(
      [
        job({ id: "late-1h", resetAt: new Date(NOW - HOUR).toISOString() }),
        job({ id: "stuck-3h", status: "resuming", resetAt: null, updatedAt: new Date(NOW - 3 * HOUR).toISOString() }),
        job({ id: "late-2h", resetAt: new Date(NOW - 2 * HOUR).toISOString() }),
      ],
      NOW,
      { stuckResumingMs: HOUR }
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["stuck-3h", "late-2h", "late-1h"]);
    expect(report.worstLateByMs).toBe(3 * HOUR);
    expect(report.byReason).toEqual({ resetPassed: 2, stuckResuming: 1 });
  });

  it("breaks ties deterministically by createdAt then id", () => {
    const reset = new Date(NOW - HOUR).toISOString();
    const report = findOverdueJobs(
      [
        job({ id: "b", resetAt: reset, createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "a", resetAt: reset, createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "z", resetAt: reset, createdAt: "2026-07-30T01:00:00.000Z" }),
      ],
      NOW
    );
    // z created earliest → first; then a before b by id.
    expect(report.entries.map((e) => e.job.id)).toEqual(["z", "a", "b"]);
  });

  it("negative/invalid tunables fall back to defaults", () => {
    const j = job({ resetAt: new Date(NOW - 1_000).toISOString() });
    // graceMs < 0 behaves as 0 (any past-due counts).
    expect(findOverdueJobs([j], NOW, { graceMs: -5 }).total).toBe(1);
    // stuckResumingMs < 0 disables the check (treated as null).
    const stuck = job({ status: "resuming", resetAt: null, updatedAt: new Date(NOW - HOUR).toISOString() });
    expect(findOverdueJobs([stuck], NOW, { stuckResumingMs: -5 }).total).toBe(0);
  });
});
