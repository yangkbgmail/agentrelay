import { describe, expect, it } from "vitest";
import type { AgentTool, JobStatus, RelayJob } from "./types.js";
import { selectUpcoming } from "./upcoming.js";

const NOW = Date.parse("2026-07-24T12:00:00.000Z");

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "proj",
    tool: "claude-code" as AgentTool,
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "waiting_for_reset" as JobStatus,
    resetAt: null,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

/** ISO string `mins` minutes after NOW. */
function resetIn(mins: number): string {
  return new Date(NOW + mins * 60_000).toISOString();
}

describe("selectUpcoming", () => {
  it("returns an empty array for an empty store", () => {
    expect(selectUpcoming([], { now: NOW })).toEqual([]);
  });

  it("ignores jobs that are not waiting_for_reset", () => {
    const jobs = [
      job({ status: "completed", resetAt: resetIn(10) }),
      job({ status: "queued", resetAt: resetIn(5) }),
      job({ status: "failed", resetAt: resetIn(1) }),
    ];
    expect(selectUpcoming(jobs, { now: NOW })).toEqual([]);
  });

  it("ignores waiting jobs with null or unparseable resetAt", () => {
    const jobs = [job({ resetAt: null }), job({ resetAt: "not-a-date" })];
    expect(selectUpcoming(jobs, { now: NOW })).toEqual([]);
  });

  it("sorts by reset time, soonest first", () => {
    const later = job({ resetAt: resetIn(60) });
    const soon = job({ resetAt: resetIn(10) });
    const mid = job({ resetAt: resetIn(30) });
    const result = selectUpcoming([later, soon, mid], { now: NOW });
    expect(result.map((e) => e.job.id)).toEqual([soon.id, mid.id, later.id]);
  });

  it("computes dueInMs and the due flag relative to now", () => {
    const overdue = job({ id: "overdue", resetAt: resetIn(-5) });
    const future = job({ id: "future", resetAt: resetIn(20) });
    const result = selectUpcoming([future, overdue], { now: NOW });
    expect(result[0].job.id).toBe("overdue");
    expect(result[0].due).toBe(true);
    expect(result[0].dueInMs).toBe(-5 * 60_000);
    expect(result[1].job.id).toBe("future");
    expect(result[1].due).toBe(false);
    expect(result[1].dueInMs).toBe(20 * 60_000);
  });

  it("breaks reset-time ties by createdAt then id, matching `next`", () => {
    const at = resetIn(10);
    const a = job({ id: "aaa", resetAt: at, createdAt: "2026-07-24T00:00:00.000Z" });
    const b = job({ id: "bbb", resetAt: at, createdAt: "2026-07-23T00:00:00.000Z" });
    // b was created earlier, so it should come first despite the same reset time.
    const result = selectUpcoming([a, b], { now: NOW });
    expect(result.map((e) => e.job.id)).toEqual([b.id, a.id]);
  });

  it("applies the withinMs window as an upper bound on dueInMs", () => {
    const soon = job({ resetAt: resetIn(10) });
    const later = job({ resetAt: resetIn(90) });
    const result = selectUpcoming([soon, later], { now: NOW, withinMs: 60 * 60_000 });
    expect(result.map((e) => e.job.id)).toEqual([soon.id]);
  });

  it("always includes already-due jobs even inside a window", () => {
    const overdue = job({ id: "overdue", resetAt: resetIn(-30) });
    const inWindow = job({ id: "in", resetAt: resetIn(10) });
    const outWindow = job({ id: "out", resetAt: resetIn(120) });
    const result = selectUpcoming([outWindow, inWindow, overdue], { now: NOW, withinMs: 60 * 60_000 });
    expect(result.map((e) => e.job.id)).toEqual(["overdue", "in"]);
  });

  it("treats a null/negative window as no window", () => {
    const jobs = [job({ resetAt: resetIn(10) }), job({ resetAt: resetIn(1000) })];
    expect(selectUpcoming(jobs, { now: NOW, withinMs: null })).toHaveLength(2);
    expect(selectUpcoming(jobs, { now: NOW, withinMs: -1 })).toHaveLength(2);
  });

  it("trims to limit after sorting", () => {
    const jobs = [job({ resetAt: resetIn(30) }), job({ resetAt: resetIn(10) }), job({ resetAt: resetIn(20) })];
    const result = selectUpcoming(jobs, { now: NOW, limit: 2 });
    expect(result).toHaveLength(2);
    expect(result[0].dueInMs).toBe(10 * 60_000);
    expect(result[1].dueInMs).toBe(20 * 60_000);
  });

  it("applies the window before the limit", () => {
    const jobs = [
      job({ id: "a", resetAt: resetIn(5) }),
      job({ id: "b", resetAt: resetIn(15) }),
      job({ id: "c", resetAt: resetIn(500) }),
    ];
    // window keeps a,b; limit 1 keeps just a.
    const result = selectUpcoming(jobs, { now: NOW, withinMs: 60 * 60_000, limit: 1 });
    expect(result.map((e) => e.job.id)).toEqual(["a"]);
  });

  it("does not mutate the input array order", () => {
    const jobs = [job({ id: "x", resetAt: resetIn(30) }), job({ id: "y", resetAt: resetIn(10) })];
    const snapshot = jobs.map((j) => j.id);
    selectUpcoming(jobs, { now: NOW });
    expect(jobs.map((j) => j.id)).toEqual(snapshot);
  });
});
