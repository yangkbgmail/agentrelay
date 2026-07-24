import { describe, expect, it } from "vitest";
import type { JobStatus, RelayJob } from "../src/types.js";
import {
  evaluateGroupWait,
  evaluateWait,
  type GroupWaitCounts,
  groupWaitOutcome,
  isTerminalStatus,
  tallyGroupWait,
  WAIT_EXIT_CODES,
  waitExitCode,
} from "../src/wait.js";

function job(status: JobStatus, id = "id"): RelayJob {
  return {
    id,
    project: "proj",
    tool: "claude-code",
    command: ["echo"],
    cwd: "/tmp",
    status,
    resetAt: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
  };
}

describe("isTerminalStatus", () => {
  it("is true only for completed/failed/cancelled", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
    expect(isTerminalStatus("queued")).toBe(false);
    expect(isTerminalStatus("waiting_for_reset")).toBe(false);
    expect(isTerminalStatus("resuming")).toBe(false);
  });
});

describe("waitExitCode", () => {
  it("maps each outcome to its documented exit code", () => {
    expect(waitExitCode("completed")).toBe(0);
    expect(waitExitCode("failed")).toBe(1);
    expect(waitExitCode("cancelled")).toBe(2);
    expect(waitExitCode("timeout")).toBe(124);
    expect(waitExitCode("missing")).toBe(5);
  });

  it("WAIT_EXIT_CODES has an entry for every outcome", () => {
    expect(Object.keys(WAIT_EXIT_CODES).sort()).toEqual(
      ["cancelled", "completed", "failed", "missing", "timeout"].sort()
    );
  });
});

describe("evaluateWait", () => {
  it("is not done for pending states", () => {
    for (const s of ["queued", "waiting_for_reset", "resuming"] as const) {
      expect(evaluateWait(job(s))).toEqual({ done: false });
    }
  });

  it("is done with the matching outcome for terminal states", () => {
    expect(evaluateWait(job("completed"))).toEqual({ done: true, outcome: "completed" });
    expect(evaluateWait(job("failed"))).toEqual({ done: true, outcome: "failed" });
    expect(evaluateWait(job("cancelled"))).toEqual({ done: true, outcome: "cancelled" });
  });

  it("treats a null (vanished) job as done/missing", () => {
    expect(evaluateWait(null)).toEqual({ done: true, outcome: "missing" });
  });
});

function byId(...jobs: RelayJob[]): Map<string, RelayJob> {
  return new Map(jobs.map((j) => [j.id, j] as const));
}

describe("tallyGroupWait", () => {
  it("buckets each watched id: pending / terminal / missing", () => {
    const jobs = byId(
      job("queued", "a"),
      job("resuming", "b"),
      job("completed", "c"),
      job("failed", "d"),
      job("cancelled", "e")
      // "f" is not in the map => missing
    );
    const counts = tallyGroupWait(["a", "b", "c", "d", "e", "f"], jobs);
    expect(counts).toEqual({ total: 6, pending: 2, completed: 1, failed: 1, cancelled: 1, missing: 1 });
  });

  it("counts only watched ids, ignoring extra jobs in the store", () => {
    const jobs = byId(job("completed", "a"), job("failed", "other"));
    expect(tallyGroupWait(["a"], jobs)).toEqual({
      total: 1,
      pending: 0,
      completed: 1,
      failed: 0,
      cancelled: 0,
      missing: 0,
    });
  });

  it("is all-zero for an empty watch set", () => {
    expect(tallyGroupWait([], byId(job("failed", "x")))).toEqual({
      total: 0,
      pending: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      missing: 0,
    });
  });
});

describe("evaluateGroupWait", () => {
  const base: GroupWaitCounts = { total: 3, pending: 0, completed: 3, failed: 0, cancelled: 0, missing: 0 };

  it("is done only when nothing is pending", () => {
    expect(evaluateGroupWait({ ...base, pending: 1, completed: 2 })).toEqual({ done: false });
    expect(evaluateGroupWait(base)).toEqual({ done: true });
  });

  it("an empty watch set is done immediately", () => {
    expect(evaluateGroupWait({ total: 0, pending: 0, completed: 0, failed: 0, cancelled: 0, missing: 0 })).toEqual({
      done: true,
    });
  });

  it("a settled-but-missing set is done (no lingering pending)", () => {
    expect(evaluateGroupWait({ total: 2, pending: 0, completed: 1, failed: 0, cancelled: 0, missing: 1 })).toEqual({
      done: true,
    });
  });
});

describe("groupWaitOutcome", () => {
  const zero: GroupWaitCounts = { total: 0, pending: 0, completed: 0, failed: 0, cancelled: 0, missing: 0 };

  it("all completed => completed", () => {
    expect(groupWaitOutcome({ ...zero, total: 2, completed: 2 }, false)).toBe("completed");
  });

  it("empty watch set => completed", () => {
    expect(groupWaitOutcome(zero, false)).toBe("completed");
  });

  it("any failure dominates, even over a timeout with pending jobs", () => {
    expect(groupWaitOutcome({ ...zero, total: 3, failed: 1, completed: 1, pending: 1 }, true)).toBe("failed");
    expect(groupWaitOutcome({ ...zero, total: 2, failed: 1, cancelled: 1 }, false)).toBe("failed");
  });

  it("timeout when the deadline hit with pending jobs and no failure", () => {
    expect(groupWaitOutcome({ ...zero, total: 2, completed: 1, pending: 1 }, true)).toBe("timeout");
  });

  it("timedOut flag is inert once nothing is pending", () => {
    expect(groupWaitOutcome({ ...zero, total: 2, completed: 2 }, true)).toBe("completed");
  });

  it("cancelled outranks missing when no failure/timeout", () => {
    expect(groupWaitOutcome({ ...zero, total: 2, cancelled: 1, missing: 1 }, false)).toBe("cancelled");
  });

  it("missing when only completed + missing", () => {
    expect(groupWaitOutcome({ ...zero, total: 2, completed: 1, missing: 1 }, false)).toBe("missing");
  });

  it("every outcome maps to a defined exit code", () => {
    for (const out of ["completed", "failed", "cancelled", "missing", "timeout"] as const) {
      expect(typeof waitExitCode(out)).toBe("number");
    }
  });
});
