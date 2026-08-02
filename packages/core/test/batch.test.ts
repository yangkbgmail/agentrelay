import { describe, expect, it } from "vitest";
import { compareResumeOrder, maxResumesPerTickFromEnv, selectResumeBatch } from "../src/batch.js";
import type { RelayJob } from "../src/types.js";

/** Build a due (`waiting_for_reset`) job with the fields the batcher inspects. */
function job(overrides: Partial<RelayJob> & { id: string }): RelayJob {
  return {
    id: overrides.id,
    project: overrides.project ?? "demo",
    tool: overrides.tool ?? "claude-code",
    command: overrides.command ?? ["claude", "-p", "continue"],
    cwd: overrides.cwd ?? "/tmp",
    status: overrides.status ?? "waiting_for_reset",
    resetAt: overrides.resetAt ?? "2026-01-01T00:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    attempts: overrides.attempts ?? 1,
    lastError: overrides.lastError ?? null,
    lastOutputTail: overrides.lastOutputTail ?? null,
  };
}

describe("selectResumeBatch", () => {
  it("returns all jobs (order-normalized) when no cap is given", () => {
    const jobs = [
      job({ id: "b", resetAt: "2026-01-01T00:00:02.000Z" }),
      job({ id: "a", resetAt: "2026-01-01T00:00:01.000Z" }),
    ];
    const batch = selectResumeBatch(jobs);
    expect(batch.map((j) => j.id)).toEqual(["a", "b"]);
  });

  it("treats undefined/null/0/negative limit as no cap", () => {
    const jobs = [job({ id: "a" }), job({ id: "b" }), job({ id: "c" })];
    for (const limit of [undefined, null, 0, -1] as const) {
      expect(selectResumeBatch(jobs, limit)).toHaveLength(3);
    }
  });

  it("caps to the most-overdue N jobs when limit is positive", () => {
    const jobs = [
      job({ id: "new", resetAt: "2026-01-01T00:00:05.000Z" }),
      job({ id: "oldest", resetAt: "2026-01-01T00:00:01.000Z" }),
      job({ id: "middle", resetAt: "2026-01-01T00:00:03.000Z" }),
    ];
    const batch = selectResumeBatch(jobs, 2);
    // Most overdue = earliest resetAt first.
    expect(batch.map((j) => j.id)).toEqual(["oldest", "middle"]);
  });

  it("does not mutate the input array", () => {
    const jobs = [
      job({ id: "b", resetAt: "2026-01-01T00:00:02.000Z" }),
      job({ id: "a", resetAt: "2026-01-01T00:00:01.000Z" }),
    ];
    const before = jobs.map((j) => j.id);
    selectResumeBatch(jobs, 1);
    expect(jobs.map((j) => j.id)).toEqual(before);
  });

  it("floors a fractional positive limit", () => {
    const jobs = [job({ id: "a" }), job({ id: "b" }), job({ id: "c" })];
    expect(selectResumeBatch(jobs, 2.9)).toHaveLength(2);
  });

  it("breaks resetAt ties by createdAt (FIFO), then id", () => {
    const jobs = [
      job({ id: "z", resetAt: "2026-01-01T00:00:01.000Z", createdAt: "2026-01-01T00:00:00.500Z" }),
      job({ id: "a", resetAt: "2026-01-01T00:00:01.000Z", createdAt: "2026-01-01T00:00:00.500Z" }),
      job({ id: "early", resetAt: "2026-01-01T00:00:01.000Z", createdAt: "2026-01-01T00:00:00.100Z" }),
    ];
    const batch = selectResumeBatch(jobs);
    // earliest createdAt first; the two same-createdAt jobs break by id (a < z).
    expect(batch.map((j) => j.id)).toEqual(["early", "a", "z"]);
  });

  it("sorts a null resetAt as most overdue rather than throwing", () => {
    const jobs = [
      job({ id: "concrete", resetAt: "2026-01-01T00:00:01.000Z" }),
      job({ id: "nullreset", resetAt: null }),
    ];
    const batch = selectResumeBatch(jobs, 1);
    expect(batch.map((j) => j.id)).toEqual(["nullreset"]);
  });

  it("returns an empty array for empty input", () => {
    expect(selectResumeBatch([], 5)).toEqual([]);
  });
});

describe("compareResumeOrder", () => {
  it("orders earlier resetAt first (negative result)", () => {
    const a = job({ id: "a", resetAt: "2026-01-01T00:00:01.000Z" });
    const b = job({ id: "b", resetAt: "2026-01-01T00:00:02.000Z" });
    expect(compareResumeOrder(a, b)).toBeLessThan(0);
    expect(compareResumeOrder(b, a)).toBeGreaterThan(0);
  });
});

describe("maxResumesPerTickFromEnv", () => {
  it("returns undefined when unset or blank", () => {
    expect(maxResumesPerTickFromEnv({})).toBeUndefined();
    expect(maxResumesPerTickFromEnv({ AGENTRELAY_MAX_RESUMES_PER_TICK: "  " })).toBeUndefined();
  });

  it("parses a positive integer", () => {
    expect(maxResumesPerTickFromEnv({ AGENTRELAY_MAX_RESUMES_PER_TICK: "3" })).toBe(3);
  });

  it("rejects non-positive, fractional, and non-numeric values (no accidental throttle)", () => {
    for (const raw of ["0", "-2", "2.5", "abc", "1e2 x"]) {
      expect(maxResumesPerTickFromEnv({ AGENTRELAY_MAX_RESUMES_PER_TICK: raw })).toBeUndefined();
    }
  });
});
