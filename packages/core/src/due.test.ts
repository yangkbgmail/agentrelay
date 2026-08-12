import { describe, expect, it } from "vitest";
import { orderDueJobs } from "./due.js";
import type { RelayJob } from "./types.js";

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "id",
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

describe("orderDueJobs", () => {
  it("puts the most-overdue job (earliest resetAt) first", () => {
    const late = job({ id: "late", resetAt: "2026-07-30T09:30:00.000Z" });
    const early = job({ id: "early", resetAt: "2026-07-30T08:00:00.000Z" });
    const mid = job({ id: "mid", resetAt: "2026-07-30T09:00:00.000Z" });

    expect(orderDueJobs([late, early, mid]).map((j) => j.id)).toEqual(["early", "mid", "late"]);
  });

  it("breaks ties on equal resetAt by creation time (older first)", () => {
    const reset = "2026-07-30T09:00:00.000Z";
    const newer = job({ id: "newer", resetAt: reset, createdAt: "2026-07-30T05:00:00.000Z" });
    const older = job({ id: "older", resetAt: reset, createdAt: "2026-07-30T01:00:00.000Z" });

    expect(orderDueJobs([newer, older]).map((j) => j.id)).toEqual(["older", "newer"]);
  });

  it("is stable when both resetAt and createdAt are equal (keeps input order)", () => {
    const reset = "2026-07-30T09:00:00.000Z";
    const created = "2026-07-30T01:00:00.000Z";
    const a = job({ id: "a", resetAt: reset, createdAt: created });
    const b = job({ id: "b", resetAt: reset, createdAt: created });
    const c = job({ id: "c", resetAt: reset, createdAt: created });

    expect(orderDueJobs([b, a, c]).map((j) => j.id)).toEqual(["b", "a", "c"]);
  });

  it("sorts a null or unparseable resetAt to the very end", () => {
    const concrete = job({ id: "concrete", resetAt: "2026-07-30T09:00:00.000Z" });
    const nullReset = job({ id: "null", resetAt: null });
    const bogus = job({ id: "bogus", resetAt: "not-a-date" });

    const ids = orderDueJobs([nullReset, bogus, concrete]).map((j) => j.id);
    expect(ids[0]).toBe("concrete");
    expect(ids.slice(1).sort()).toEqual(["bogus", "null"]);
  });

  it("does not mutate the input array", () => {
    const a = job({ id: "a", resetAt: "2026-07-30T09:30:00.000Z" });
    const b = job({ id: "b", resetAt: "2026-07-30T08:00:00.000Z" });
    const input = [a, b];

    orderDueJobs(input);
    expect(input.map((j) => j.id)).toEqual(["a", "b"]);
  });

  it("returns an empty array unchanged", () => {
    expect(orderDueJobs([])).toEqual([]);
  });
});
