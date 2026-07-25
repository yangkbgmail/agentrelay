import { describe, expect, it } from "vitest";
import type { RelayJob } from "../src/types.js";
import { selectUpcomingResumes } from "../src/upcoming.js";

const NOW = Date.parse("2026-07-13T00:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "id",
    project: "proj",
    tool: "claude-code",
    command: ["echo"],
    cwd: "/tmp",
    status: "waiting_for_reset",
    resetAt: at(60 * 60_000),
    createdAt: at(-1000),
    updatedAt: at(-1000),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("selectUpcomingResumes", () => {
  it("returns an empty schedule for an empty queue", () => {
    const schedule = selectUpcomingResumes([], NOW);
    expect(schedule.resumes).toEqual([]);
    expect(schedule.totalWaiting).toBe(0);
    expect(schedule.dueNow).toBe(0);
    expect(schedule.hidden).toBe(0);
  });

  it("includes only jobs waiting for a reset with a parseable resetAt", () => {
    const schedule = selectUpcomingResumes(
      [
        job({ id: "a", status: "completed", resetAt: at(-3600_000) }),
        job({ id: "b", status: "resuming", resetAt: at(3600_000) }),
        job({ id: "c", status: "queued", resetAt: null }),
        job({ id: "d", status: "waiting_for_reset", resetAt: null }),
        job({ id: "e", status: "waiting_for_reset", resetAt: "not-a-date" }),
        job({ id: "f", status: "waiting_for_reset", resetAt: at(90 * 60_000) }),
      ],
      NOW
    );
    expect(schedule.resumes.map((r) => r.job.id)).toEqual(["f"]);
    expect(schedule.totalWaiting).toBe(1);
  });

  it("orders resumes by earliest reset first", () => {
    const schedule = selectUpcomingResumes(
      [
        job({ id: "a", resetAt: at(3 * 3600_000) }),
        job({ id: "b", resetAt: at(1 * 3600_000) }),
        job({ id: "c", resetAt: at(2 * 3600_000) }),
      ],
      NOW
    );
    expect(schedule.resumes.map((r) => r.job.id)).toEqual(["b", "c", "a"]);
    expect(schedule.totalWaiting).toBe(3);
    expect(schedule.hidden).toBe(0);
  });

  it("computes dueInMs and due per resume", () => {
    const schedule = selectUpcomingResumes(
      [
        job({ id: "past", resetAt: at(-5 * 60_000) }),
        job({ id: "future", resetAt: at(30 * 60_000) }),
        job({ id: "now", resetAt: at(0) }),
      ],
      NOW
    );
    const byId = Object.fromEntries(schedule.resumes.map((r) => [r.job.id, r]));
    expect(byId.past.due).toBe(true);
    expect(byId.past.dueInMs).toBe(-5 * 60_000);
    expect(byId.now.due).toBe(true);
    expect(byId.future.due).toBe(false);
    expect(byId.future.dueInMs).toBe(30 * 60_000);
  });

  it("counts jobs that are already due (reset passed or exactly now)", () => {
    const schedule = selectUpcomingResumes(
      [job({ id: "a", resetAt: at(-1) }), job({ id: "b", resetAt: at(0) }), job({ id: "c", resetAt: at(60_000) })],
      NOW
    );
    expect(schedule.dueNow).toBe(2);
    expect(schedule.totalWaiting).toBe(3);
  });

  it("truncates to limit but reports full totals and hidden count", () => {
    const jobs = [
      job({ id: "a", resetAt: at(1 * 3600_000) }),
      job({ id: "b", resetAt: at(2 * 3600_000) }),
      job({ id: "c", resetAt: at(3 * 3600_000) }),
      job({ id: "d", resetAt: at(4 * 3600_000) }),
    ];
    const schedule = selectUpcomingResumes(jobs, NOW, { limit: 2 });
    expect(schedule.resumes.map((r) => r.job.id)).toEqual(["a", "b"]);
    expect(schedule.totalWaiting).toBe(4);
    expect(schedule.hidden).toBe(2);
  });

  it("treats a non-positive limit as no limit", () => {
    const jobs = [job({ id: "a", resetAt: at(1 * 3600_000) }), job({ id: "b", resetAt: at(2 * 3600_000) })];
    expect(selectUpcomingResumes(jobs, NOW, { limit: 0 }).resumes).toHaveLength(2);
    expect(selectUpcomingResumes(jobs, NOW, { limit: -3 }).hidden).toBe(0);
  });

  it("breaks reset-time ties deterministically by createdAt then id", () => {
    const sameReset = at(60 * 60_000);
    const schedule = selectUpcomingResumes(
      [
        job({ id: "zeta", resetAt: sameReset, createdAt: at(-500) }),
        job({ id: "alpha", resetAt: sameReset, createdAt: at(-500) }),
        job({ id: "older", resetAt: sameReset, createdAt: at(-9999) }),
      ],
      NOW
    );
    expect(schedule.resumes.map((r) => r.job.id)).toEqual(["older", "alpha", "zeta"]);
  });

  it("does not mutate the input array's order", () => {
    const jobs = [job({ id: "a", resetAt: at(3 * 3600_000) }), job({ id: "b", resetAt: at(1 * 3600_000) })];
    const before = jobs.map((j) => j.id);
    selectUpcomingResumes(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(before);
  });
});
