import { describe, expect, it } from "vitest";
import { selectNextResume } from "./next.js";
import type { RelayJob } from "./types.js";
import { selectUpcomingResumes } from "./upcoming.js";

const NOW = Date.parse("2026-07-13T00:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
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
  it("returns an empty timeline for an empty store", () => {
    const result = selectUpcomingResumes([], { now: NOW });
    expect(result.entries).toEqual([]);
    expect(result.totalWaiting).toBe(0);
    expect(result.shown).toBe(0);
    expect(result.spanMs).toBeNull();
  });

  it("only includes waiting_for_reset jobs with a parseable resetAt", () => {
    const jobs = [
      job({ status: "completed", resetAt: at(30 * 60_000) }),
      job({ status: "queued", resetAt: null }),
      job({ status: "waiting_for_reset", resetAt: null }),
      job({ status: "waiting_for_reset", resetAt: "not-a-date" }),
      job({ status: "waiting_for_reset", resetAt: at(45 * 60_000) }),
    ];
    const result = selectUpcomingResumes(jobs, { now: NOW });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].resetAtMs).toBe(NOW + 45 * 60_000);
  });

  it("orders entries by earliest reset first", () => {
    const jobs = [
      job({ id: "late", resetAt: at(3 * 60 * 60_000) }),
      job({ id: "soon", resetAt: at(30 * 60_000) }),
      job({ id: "mid", resetAt: at(90 * 60_000) }),
    ];
    const result = selectUpcomingResumes(jobs, { now: NOW });
    expect(result.entries.map((e) => e.job.id)).toEqual(["soon", "mid", "late"]);
  });

  it("breaks reset ties by createdAt then id (deterministic)", () => {
    const jobs = [
      job({ id: "b", resetAt: at(60 * 60_000), createdAt: at(-500) }),
      job({ id: "a", resetAt: at(60 * 60_000), createdAt: at(-500) }),
      job({ id: "older", resetAt: at(60 * 60_000), createdAt: at(-9000) }),
    ];
    const result = selectUpcomingResumes(jobs, { now: NOW });
    expect(result.entries.map((e) => e.job.id)).toEqual(["older", "a", "b"]);
  });

  it("computes dueInMs/due relative to now", () => {
    const jobs = [job({ id: "past", resetAt: at(-1000) }), job({ id: "future", resetAt: at(120 * 60_000) })];
    const result = selectUpcomingResumes(jobs, { now: NOW });
    expect(result.entries[0].job.id).toBe("past");
    expect(result.entries[0].due).toBe(true);
    expect(result.entries[0].dueInMs).toBe(-1000);
    expect(result.entries[1].due).toBe(false);
    expect(result.entries[1].dueInMs).toBe(120 * 60_000);
  });

  it("computes gapFromPreviousMs between consecutive resumes (0 for the first)", () => {
    const jobs = [
      job({ resetAt: at(30 * 60_000) }),
      job({ resetAt: at(90 * 60_000) }),
      job({ resetAt: at(120 * 60_000) }),
    ];
    const result = selectUpcomingResumes(jobs, { now: NOW });
    expect(result.entries.map((e) => e.gapFromPreviousMs)).toEqual([0, 60 * 60_000, 30 * 60_000]);
  });

  it("reports spanMs across the shown entries and null for fewer than two", () => {
    const single = selectUpcomingResumes([job({ resetAt: at(60 * 60_000) })], { now: NOW });
    expect(single.spanMs).toBeNull();

    const many = selectUpcomingResumes([job({ resetAt: at(30 * 60_000) }), job({ resetAt: at(150 * 60_000) })], {
      now: NOW,
    });
    expect(many.spanMs).toBe(120 * 60_000);
  });

  it("caps entries at a positive integer limit while totalWaiting counts all", () => {
    const jobs = [
      job({ resetAt: at(10 * 60_000) }),
      job({ resetAt: at(20 * 60_000) }),
      job({ resetAt: at(30 * 60_000) }),
      job({ resetAt: at(40 * 60_000) }),
    ];
    const result = selectUpcomingResumes(jobs, { now: NOW, limit: 2 });
    expect(result.shown).toBe(2);
    expect(result.totalWaiting).toBe(4);
    expect(result.entries.map((e) => e.resetAtMs)).toEqual([NOW + 10 * 60_000, NOW + 20 * 60_000]);
    // span reflects only the shown window, not the full waiting set.
    expect(result.spanMs).toBe(10 * 60_000);
  });

  it("treats a non-positive or non-integer limit as no cap (defensive)", () => {
    const jobs = [job({ resetAt: at(10 * 60_000) }), job({ resetAt: at(20 * 60_000) })];
    expect(selectUpcomingResumes(jobs, { now: NOW, limit: 0 }).shown).toBe(2);
    expect(selectUpcomingResumes(jobs, { now: NOW, limit: -1 }).shown).toBe(2);
    expect(selectUpcomingResumes(jobs, { now: NOW, limit: 1.5 }).shown).toBe(2);
  });

  it("does not mutate the input array order", () => {
    const jobs = [job({ id: "late", resetAt: at(90 * 60_000) }), job({ id: "soon", resetAt: at(10 * 60_000) })];
    const before = jobs.map((j) => j.id);
    selectUpcomingResumes(jobs, { now: NOW });
    expect(jobs.map((j) => j.id)).toEqual(before);
  });

  it("first entry equals the job `next` would pick (shared ordering invariant)", () => {
    const jobs = [
      job({ id: "c", resetAt: at(90 * 60_000) }),
      job({ id: "a", resetAt: at(30 * 60_000) }),
      job({ id: "b", resetAt: at(60 * 60_000) }),
    ];
    const upcoming = selectUpcomingResumes(jobs, { now: NOW });
    const next = selectNextResume(jobs, NOW);
    expect(upcoming.entries[0].job.id).toBe(next?.job.id);
    // and the count behind `next` matches the rest of the timeline.
    expect(next?.waitingBehind).toBe(upcoming.totalWaiting - 1);
  });
});
