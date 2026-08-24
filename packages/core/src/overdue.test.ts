import { describe, expect, it } from "vitest";
import { buildOverdueReport } from "./overdue.js";
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
const HOUR = 60 * 60 * 1000;

describe("buildOverdueReport", () => {
  it("returns an empty report when nothing is overdue", () => {
    const report = buildOverdueReport([], NOW);
    expect(report).toEqual({
      entries: [],
      totalOverdue: 0,
      unschedulable: 0,
      hidden: 0,
      graceMs: 0,
      maxOverdueByMs: 0,
    });
  });

  it("ignores jobs that are not waiting_for_reset even if their resetAt is past", () => {
    const report = buildOverdueReport(
      [
        job({ status: "completed", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "queued", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "resuming", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "failed", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.totalOverdue).toBe(0);
  });

  it("ignores waiting jobs whose reset is still in the future", () => {
    const report = buildOverdueReport(
      [
        job({ id: "future", resetAt: "2026-07-30T11:00:00.000Z" }),
        job({ id: "past", resetAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["past"]);
    expect(report.totalOverdue).toBe(1);
  });

  it("ignores waiting jobs with a null resetAt (not genuinely parked on a reset)", () => {
    const report = buildOverdueReport(
      [job({ id: "no-reset", resetAt: null }), job({ id: "good", resetAt: "2026-07-30T08:00:00.000Z" })],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["good"]);
    expect(report.unschedulable).toBe(0);
  });

  it("surfaces a waiting job with an unparseable resetAt as unschedulable, ranked first", () => {
    // `isJobDue` treats an unparseable (non-null) resetAt as due every tick, so
    // such a job is stuck-and-due; overdue must not hide it (it did pre-#812).
    const report = buildOverdueReport(
      [
        job({ id: "good", resetAt: "2026-07-30T08:00:00.000Z" }), // 2h overdue
        job({ id: "bad-reset", resetAt: "next tuesday", updatedAt: "2026-07-30T09:30:00.000Z" }), // parked 30m ago
      ],
      NOW
    );
    // Unschedulable ranks ahead of the placeable job even though its span is shorter.
    expect(report.entries.map((e) => e.job.id)).toEqual(["bad-reset", "good"]);
    expect(report.entries[0].unschedulable).toBe(true);
    expect(report.entries[0].overdueByMs).toBe(30 * 60 * 1000); // now - updatedAt
    expect(report.entries[1].unschedulable).toBe(false);
    expect(report.totalOverdue).toBe(2);
    expect(report.unschedulable).toBe(1);
    // "worst" reflects the longest span across both kinds (the placeable 2h job).
    expect(report.maxOverdueByMs).toBe(2 * HOUR);
  });

  it("measures an unschedulable job from its parked time, protected by grace", () => {
    const jobs = [
      job({ id: "just-parked", resetAt: "garbage", updatedAt: "2026-07-30T09:59:30.000Z" }), // 30s ago
      job({ id: "long-parked", resetAt: "garbage", updatedAt: "2026-07-30T07:00:00.000Z" }), // 3h ago
    ];
    const report = buildOverdueReport(jobs, NOW, { graceMs: 60 * 1000 });
    // The freshly-parked corrupt job is within grace and not flagged yet.
    expect(report.entries.map((e) => e.job.id)).toEqual(["long-parked"]);
    expect(report.entries[0].overdueByMs).toBe(3 * HOUR);
    expect(report.unschedulable).toBe(1);
  });

  it("still surfaces an unschedulable job whose parked timestamps are also corrupt", () => {
    const report = buildOverdueReport(
      [job({ id: "fully-corrupt", resetAt: "nope", updatedAt: "nope", createdAt: "nope" })],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["fully-corrupt"]);
    expect(report.entries[0].unschedulable).toBe(true);
    expect(report.entries[0].overdueByMs).toBe(0);
    expect(report.unschedulable).toBe(1);
  });

  it("does not treat a reset exactly at now (or in the future) as overdue", () => {
    const report = buildOverdueReport(
      [
        job({ id: "exactly-now", resetAt: "2026-07-30T10:00:00.000Z" }),
        job({ id: "one-ms-past", resetAt: "2026-07-30T09:59:59.999Z" }),
      ],
      NOW
    );
    // Exactly-now is "due", not "overdue"; one ms past counts.
    expect(report.entries.map((e) => e.job.id)).toEqual(["one-ms-past"]);
  });

  it("ranks the most-overdue job first and computes overdueByMs", () => {
    const report = buildOverdueReport(
      [
        job({ id: "recent", resetAt: "2026-07-30T09:30:00.000Z" }),
        job({ id: "ancient", resetAt: "2026-07-30T06:00:00.000Z" }),
        job({ id: "mid", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["ancient", "mid", "recent"]);
    expect(report.entries[0].overdueByMs).toBe(4 * HOUR);
    expect(report.maxOverdueByMs).toBe(4 * HOUR);
  });

  it("breaks ties deterministically by createdAt then id", () => {
    const report = buildOverdueReport(
      [
        job({ id: "b", resetAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "a", resetAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "c", resetAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
      ],
      NOW
    );
    // Same reset → oldest createdAt first (c), then id order (a before b).
    expect(report.entries.map((e) => e.job.id)).toEqual(["c", "a", "b"]);
  });

  it("honors the grace window so freshly-due jobs are not flagged", () => {
    const jobs = [
      job({ id: "just-due", resetAt: "2026-07-30T09:59:30.000Z" }), // 30s past
      job({ id: "long-due", resetAt: "2026-07-30T08:00:00.000Z" }), // 2h past
    ];
    const report = buildOverdueReport(jobs, NOW, { graceMs: 60 * 1000 });
    expect(report.entries.map((e) => e.job.id)).toEqual(["long-due"]);
    expect(report.graceMs).toBe(60 * 1000);
  });

  it("treats a negative or non-finite grace as zero", () => {
    const jobs = [job({ id: "one-ms-past", resetAt: "2026-07-30T09:59:59.999Z" })];
    expect(buildOverdueReport(jobs, NOW, { graceMs: -5000 }).graceMs).toBe(0);
    expect(buildOverdueReport(jobs, NOW, { graceMs: Number.NaN }).graceMs).toBe(0);
    expect(buildOverdueReport(jobs, NOW, { graceMs: -5000 }).totalOverdue).toBe(1);
  });

  it("trims to the limit while keeping totals and maxOverdueByMs honest", () => {
    const report = buildOverdueReport(
      [
        job({ id: "j1", resetAt: "2026-07-30T06:00:00.000Z" }),
        job({ id: "j2", resetAt: "2026-07-30T07:00:00.000Z" }),
        job({ id: "j3", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ id: "j4", resetAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW,
      { limit: 2 }
    );
    expect(report.entries.map((e) => e.job.id)).toEqual(["j1", "j2"]);
    expect(report.totalOverdue).toBe(4);
    expect(report.hidden).toBe(2);
    expect(report.maxOverdueByMs).toBe(4 * HOUR);
  });

  it("ignores a non-positive or non-integer limit and shows everything", () => {
    const jobs = [
      job({ id: "j1", resetAt: "2026-07-30T08:00:00.000Z" }),
      job({ id: "j2", resetAt: "2026-07-30T09:00:00.000Z" }),
    ];
    expect(buildOverdueReport(jobs, NOW, { limit: 0 }).entries).toHaveLength(0);
    expect(buildOverdueReport(jobs, NOW, { limit: 1.5 }).entries).toHaveLength(2);
    expect(buildOverdueReport(jobs, NOW, {}).entries).toHaveLength(2);
  });

  it("does not mutate the input array order", () => {
    const jobs = [
      job({ id: "recent", resetAt: "2026-07-30T09:30:00.000Z" }),
      job({ id: "ancient", resetAt: "2026-07-30T06:00:00.000Z" }),
    ];
    buildOverdueReport(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(["recent", "ancient"]);
  });
});
