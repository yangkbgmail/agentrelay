import { describe, expect, it } from "vitest";
import { planTick } from "./tick.js";
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

describe("planTick", () => {
  it("returns an empty plan when nothing is due", () => {
    expect(planTick([], NOW)).toEqual({ resumes: [], total: 0, referenceTimeMs: NOW });
  });

  it("selects only waiting_for_reset jobs whose reset time is at or before now", () => {
    const plan = planTick(
      [
        job({ id: "due", resetAt: "2026-07-30T09:00:00.000Z" }),
        job({ id: "future", resetAt: "2026-07-30T11:00:00.000Z" }),
      ],
      NOW
    );
    expect(plan.total).toBe(1);
    expect(plan.resumes[0].job.id).toBe("due");
  });

  it("includes a job whose reset is exactly now (<= is inclusive, matching listDue)", () => {
    const plan = planTick([job({ id: "boundary", resetAt: "2026-07-30T10:00:00.000Z" })], NOW);
    expect(plan.total).toBe(1);
    expect(plan.resumes[0].overdueByMs).toBe(0);
  });

  it("ignores non-waiting jobs even when their resetAt is in the past", () => {
    const plan = planTick(
      [
        job({ status: "completed", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "queued", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "resuming", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "failed", resetAt: "2026-07-30T08:00:00.000Z" }),
        job({ status: "cancelled", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(plan.total).toBe(0);
  });

  it("ignores waiting jobs with null or unparseable resetAt", () => {
    const plan = planTick(
      [
        job({ id: "no-reset", resetAt: null }),
        job({ id: "garbage", resetAt: "not-a-date" }),
        job({ id: "ok", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(plan.resumes.map((r) => r.job.id)).toEqual(["ok"]);
  });

  it("computes overdueByMs as now minus the reset time", () => {
    const plan = planTick([job({ resetAt: "2026-07-30T08:00:00.000Z" })], NOW);
    expect(plan.resumes[0].overdueByMs).toBe(2 * HOUR);
  });

  it("ranks most-overdue first, then oldest createdAt, then id", () => {
    const plan = planTick(
      [
        job({ id: "recent", resetAt: "2026-07-30T09:30:00.000Z" }),
        job({ id: "oldest", resetAt: "2026-07-30T07:00:00.000Z" }),
        job({ id: "middle", resetAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(plan.resumes.map((r) => r.job.id)).toEqual(["oldest", "middle", "recent"]);
  });

  it("breaks a shared reset time by createdAt then id (deterministic order)", () => {
    const plan = planTick(
      [
        job({ id: "b", resetAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
        job({ id: "a", resetAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
        job({ id: "earlier", resetAt: "2026-07-30T08:00:00.000Z", createdAt: "2026-07-30T00:00:00.000Z" }),
      ],
      NOW
    );
    expect(plan.resumes.map((r) => r.job.id)).toEqual(["earlier", "a", "b"]);
  });

  it("does not mutate the input array", () => {
    const jobs = [
      job({ id: "second", resetAt: "2026-07-30T09:00:00.000Z" }),
      job({ id: "first", resetAt: "2026-07-30T07:00:00.000Z" }),
    ];
    const before = jobs.map((j) => j.id);
    planTick(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(before);
  });
});
