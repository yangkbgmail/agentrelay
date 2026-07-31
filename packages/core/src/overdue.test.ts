import { describe, expect, it } from "vitest";
import { buildOverdueReport, DEFAULT_OVERDUE_GRACE_MS } from "./overdue.js";
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

const NOW = Date.parse("2026-07-30T13:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describe("buildOverdueReport", () => {
  it("returns an empty report when nothing is waiting", () => {
    const report = buildOverdueReport([], NOW);
    expect(report).toEqual({
      entries: [],
      totalOverdue: 0,
      hidden: 0,
      graceMs: DEFAULT_OVERDUE_GRACE_MS,
    });
  });

  it("flags a waiting job whose reset passed beyond the grace window", () => {
    // reset at 12:00, now 13:00 → 1h overdue, well past the 2m grace.
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T12:00:00.000Z" })], NOW);
    expect(report.totalOverdue).toBe(1);
    expect(report.entries[0].overdueByMs).toBe(HOUR);
    expect(report.entries[0].position).toBe(1);
  });

  it("does not flag a job still within the grace window", () => {
    // reset one minute ago, default grace is two minutes → not overdue yet.
    const report = buildOverdueReport([job({ resetAt: new Date(NOW - 60_000).toISOString() })], NOW);
    expect(report.totalOverdue).toBe(0);
    expect(report.entries).toHaveLength(0);
  });

  it("does not flag a job whose reset is still in the future", () => {
    const report = buildOverdueReport([job({ resetAt: new Date(NOW + HOUR).toISOString() })], NOW);
    expect(report.totalOverdue).toBe(0);
  });

  it("ignores jobs that are not waiting_for_reset even if resetAt is long past", () => {
    const past = "2026-07-30T00:00:00.000Z";
    const report = buildOverdueReport(
      [
        job({ status: "completed", resetAt: past }),
        job({ status: "queued", resetAt: past }),
        job({ status: "resuming", resetAt: past }),
        job({ status: "failed", resetAt: past }),
        job({ status: "cancelled", resetAt: past }),
      ],
      NOW
    );
    expect(report.totalOverdue).toBe(0);
  });

  it("ignores waiting jobs with a null or unparseable resetAt", () => {
    const report = buildOverdueReport([job({ resetAt: null }), job({ resetAt: "not-a-date" })], NOW);
    expect(report.totalOverdue).toBe(0);
  });

  it("orders worst-overdue first, then by createdAt, then id", () => {
    const report = buildOverdueReport(
      [
        job({ id: "b", resetAt: "2026-07-30T12:30:00.000Z" }), // 30m overdue
        job({ id: "a", resetAt: "2026-07-30T11:00:00.000Z" }), // 2h overdue (worst)
        job({ id: "c", resetAt: "2026-07-30T12:45:00.000Z" }), // 15m overdue
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["a", "b", "c"]);
    expect(report.entries.map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it("breaks a tie on equal overdue by createdAt then id", () => {
    const report = buildOverdueReport(
      [
        job({ id: "z", resetAt: "2026-07-30T12:00:00.000Z", createdAt: "2026-07-30T05:00:00.000Z" }),
        job({ id: "a", resetAt: "2026-07-30T12:00:00.000Z", createdAt: "2026-07-30T05:00:00.000Z" }),
        job({ id: "m", resetAt: "2026-07-30T12:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
      ],
      NOW
    );
    // oldest createdAt (m) first, then a before z by id.
    expect(report.entries.map((e) => e.job.id)).toEqual(["m", "a", "z"]);
  });

  it("honours a custom grace period", () => {
    // reset 90s ago; grace 30s → overdue; grace 5m → not.
    const jobs = [job({ resetAt: new Date(NOW - 90_000).toISOString() })];
    expect(buildOverdueReport(jobs, NOW, { graceMs: 30_000 }).totalOverdue).toBe(1);
    expect(buildOverdueReport(jobs, NOW, { graceMs: 5 * 60_000 }).totalOverdue).toBe(0);
  });

  it("floors a negative grace to zero (any past-due job counts)", () => {
    const report = buildOverdueReport([job({ resetAt: new Date(NOW - 1).toISOString() })], NOW, {
      graceMs: -1000,
    });
    expect(report.graceMs).toBe(0);
    expect(report.totalOverdue).toBe(1);
  });

  it("trims entries to limit but keeps honest totals", () => {
    const report = buildOverdueReport(
      [
        job({ id: "a", resetAt: "2026-07-30T11:00:00.000Z" }),
        job({ id: "b", resetAt: "2026-07-30T11:30:00.000Z" }),
        job({ id: "c", resetAt: "2026-07-30T11:45:00.000Z" }),
      ],
      NOW,
      { limit: 2 }
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["a", "b"]);
    expect(report.totalOverdue).toBe(3);
    expect(report.hidden).toBe(1);
  });

  it("treats limit 0 as show-none while totals still count all", () => {
    const report = buildOverdueReport([job({ resetAt: "2026-07-30T11:00:00.000Z" })], NOW, { limit: 0 });
    expect(report.entries).toHaveLength(0);
    expect(report.totalOverdue).toBe(1);
    expect(report.hidden).toBe(1);
  });

  it("uses ambient now when omitted (smoke: nothing overdue for a far-future reset)", () => {
    const report = buildOverdueReport([job({ resetAt: "2999-01-01T00:00:00.000Z" })]);
    expect(report.totalOverdue).toBe(0);
  });
});
