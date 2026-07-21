import { describe, expect, it } from "vitest";
import { selectUpcomingResumes } from "../src/next.js";
import type { RelayJob } from "../src/types.js";

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
    const result = selectUpcomingResumes([], { now: NOW });
    expect(result.entries).toEqual([]);
    expect(result.totalWaiting).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("includes only jobs waiting for a reset with a parseable resetAt", () => {
    const result = selectUpcomingResumes(
      [
        job({ id: "a", status: "completed", resetAt: at(-1000) }),
        job({ id: "b", status: "resuming", resetAt: at(1000) }),
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

  it("orders entries soonest-reset-first with 1-based positions", () => {
    const result = selectUpcomingResumes(
      [
        job({ id: "a", resetAt: at(3 * 3600_000) }),
        job({ id: "b", resetAt: at(1 * 3600_000) }),
        job({ id: "c", resetAt: at(2 * 3600_000) }),
      ],
      { now: NOW }
    );
    expect(result.entries.map((e) => e.job.id)).toEqual(["b", "c", "a"]);
    expect(result.entries.map((e) => e.position)).toEqual([1, 2, 3]);
    expect(result.totalWaiting).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("breaks reset-time ties deterministically by createdAt then id (matching next)", () => {
    const sameReset = at(60 * 60_000);
    const result = selectUpcomingResumes(
      [
        job({ id: "zeta", resetAt: sameReset, createdAt: at(-500) }),
        job({ id: "alpha", resetAt: sameReset, createdAt: at(-500) }),
        job({ id: "older", resetAt: sameReset, createdAt: at(-9999) }),
      ],
      { now: NOW }
    );
    expect(result.entries.map((e) => e.job.id)).toEqual(["older", "alpha", "zeta"]);
  });

  it("reports due/dueInMs per entry", () => {
    const result = selectUpcomingResumes(
      [job({ id: "future", resetAt: at(30 * 60_000) }), job({ id: "past", resetAt: at(-5 * 60_000) })],
      { now: NOW }
    );
    const past = result.entries.find((e) => e.job.id === "past");
    const future = result.entries.find((e) => e.job.id === "future");
    expect(past?.due).toBe(true);
    expect(past?.dueInMs).toBe(-5 * 60_000);
    expect(future?.due).toBe(false);
    expect(future?.dueInMs).toBe(30 * 60_000);
  });

  it("caps entries at limit and flags truncation while totalWaiting stays full", () => {
    const jobs = Array.from({ length: 5 }, (_, i) => job({ id: `j${i}`, resetAt: at((i + 1) * 3600_000) }));
    const result = selectUpcomingResumes(jobs, { now: NOW, limit: 2 });
    expect(result.entries.map((e) => e.job.id)).toEqual(["j0", "j1"]);
    expect(result.totalWaiting).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it("treats a limit >= the waiting count as no truncation", () => {
    const jobs = [job({ id: "a", resetAt: at(1000) }), job({ id: "b", resetAt: at(2000) })];
    const result = selectUpcomingResumes(jobs, { now: NOW, limit: 5 });
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it("returns every waiting job when limit is absent or non-positive", () => {
    const jobs = [job({ id: "a", resetAt: at(1000) }), job({ id: "b", resetAt: at(2000) })];
    expect(selectUpcomingResumes(jobs, { now: NOW }).entries).toHaveLength(2);
    expect(selectUpcomingResumes(jobs, { now: NOW, limit: 0 }).entries).toHaveLength(0);
    expect(selectUpcomingResumes(jobs, { now: NOW, limit: 0 }).truncated).toBe(true);
  });

  it("does not mutate the input array order", () => {
    const jobs = [job({ id: "a", resetAt: at(3000) }), job({ id: "b", resetAt: at(1000) })];
    selectUpcomingResumes(jobs, { now: NOW });
    expect(jobs.map((j) => j.id)).toEqual(["a", "b"]);
  });
});
