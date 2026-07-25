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
  it("returns an empty timeline for an empty queue", () => {
    const result = selectUpcomingResumes([], { now: NOW });
    expect(result.entries).toEqual([]);
    expect(result.totalWaiting).toBe(0);
    expect(result.hidden).toBe(0);
  });

  it("includes only waiting jobs with a parseable resetAt", () => {
    const result = selectUpcomingResumes(
      [
        job({ id: "a", status: "completed", resetAt: at(-3600_000) }),
        job({ id: "b", status: "resuming", resetAt: at(3600_000) }),
        job({ id: "c", status: "queued", resetAt: null }),
        job({ id: "d", status: "waiting_for_reset", resetAt: null }),
        job({ id: "e", status: "waiting_for_reset", resetAt: "not-a-date" }),
        job({ id: "f", status: "waiting_for_reset", resetAt: at(90 * 60_000) }),
      ],
      { now: NOW }
    );
    expect(result.entries.map((e) => e.job.id)).toEqual(["f"]);
    expect(result.totalWaiting).toBe(1);
  });

  it("orders entries soonest-first", () => {
    const result = selectUpcomingResumes(
      [
        job({ id: "a", resetAt: at(3 * 3600_000) }),
        job({ id: "b", resetAt: at(1 * 3600_000) }),
        job({ id: "c", resetAt: at(2 * 3600_000) }),
      ],
      { now: NOW }
    );
    expect(result.entries.map((e) => e.job.id)).toEqual(["b", "c", "a"]);
    expect(result.totalWaiting).toBe(3);
    expect(result.hidden).toBe(0);
  });

  it("computes dueInMs and due per entry", () => {
    const result = selectUpcomingResumes(
      [
        job({ id: "past", resetAt: at(-5 * 60_000) }),
        job({ id: "now", resetAt: at(0) }),
        job({ id: "future", resetAt: at(30 * 60_000) }),
      ],
      { now: NOW }
    );
    const byId = Object.fromEntries(result.entries.map((e) => [e.job.id, e]));
    expect(byId.past.due).toBe(true);
    expect(byId.past.dueInMs).toBe(-5 * 60_000);
    expect(byId.now.due).toBe(true);
    expect(byId.now.dueInMs).toBe(0);
    expect(byId.future.due).toBe(false);
    expect(byId.future.dueInMs).toBe(30 * 60_000);
  });

  it("caps entries to a positive limit and reports the hidden remainder", () => {
    const jobs = [
      job({ id: "a", resetAt: at(1 * 3600_000) }),
      job({ id: "b", resetAt: at(2 * 3600_000) }),
      job({ id: "c", resetAt: at(3 * 3600_000) }),
      job({ id: "d", resetAt: at(4 * 3600_000) }),
    ];
    const result = selectUpcomingResumes(jobs, { now: NOW, limit: 2 });
    expect(result.entries.map((e) => e.job.id)).toEqual(["a", "b"]);
    expect(result.totalWaiting).toBe(4);
    expect(result.hidden).toBe(2);
  });

  it("ignores a non-positive or non-integer limit (no cap)", () => {
    const jobs = [job({ id: "a", resetAt: at(1000) }), job({ id: "b", resetAt: at(2000) })];
    expect(selectUpcomingResumes(jobs, { now: NOW, limit: 0 }).entries.length).toBe(2);
    expect(selectUpcomingResumes(jobs, { now: NOW, limit: -1 }).entries.length).toBe(2);
    expect(selectUpcomingResumes(jobs, { now: NOW, limit: 1.5 }).entries.length).toBe(2);
    expect(selectUpcomingResumes(jobs, { now: NOW, limit: 5 }).hidden).toBe(0);
  });

  it("breaks reset-time ties deterministically by createdAt then id", () => {
    const sameReset = at(60 * 60_000);
    const result = selectUpcomingResumes(
      [
        job({ id: "zeta", resetAt: sameReset, createdAt: at(-500) }),
        job({ id: "alpha", resetAt: sameReset, createdAt: at(-500) }),
        job({ id: "younger", resetAt: sameReset, createdAt: at(-100) }),
        job({ id: "older", resetAt: sameReset, createdAt: at(-9999) }),
      ],
      { now: NOW }
    );
    expect(result.entries.map((e) => e.job.id)).toEqual(["older", "alpha", "zeta", "younger"]);
  });

  it("does not mutate the input array order", () => {
    const jobs = [
      job({ id: "a", resetAt: at(3000) }),
      job({ id: "b", resetAt: at(1000) }),
      job({ id: "c", resetAt: at(2000) }),
    ];
    selectUpcomingResumes(jobs, { now: NOW });
    expect(jobs.map((j) => j.id)).toEqual(["a", "b", "c"]);
  });
});
