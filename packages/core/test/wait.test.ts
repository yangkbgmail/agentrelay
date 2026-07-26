import { describe, expect, it } from "vitest";
import type { JobStatus, RelayJob } from "../src/types.js";
import {
  evaluateWait,
  evaluateWaitBatch,
  isTerminalStatus,
  WAIT_EXIT_CODES,
  waitBatchOutcome,
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

describe("evaluateWaitBatch", () => {
  it("an empty set is trivially done with all-zero tallies", () => {
    expect(evaluateWaitBatch([])).toEqual({
      done: true,
      state: { total: 0, pending: 0, completed: 0, failed: 0, cancelled: 0 },
    });
  });

  it("is not done while any job is still pending", () => {
    const { done, state } = evaluateWaitBatch([job("completed", "a"), job("queued", "b")]);
    expect(done).toBe(false);
    expect(state).toEqual({ total: 2, pending: 1, completed: 1, failed: 0, cancelled: 0 });
  });

  it("counts every pending sub-state as pending", () => {
    const { done, state } = evaluateWaitBatch([
      job("queued", "a"),
      job("waiting_for_reset", "b"),
      job("resuming", "c"),
    ]);
    expect(done).toBe(false);
    expect(state.pending).toBe(3);
    expect(state.total).toBe(3);
  });

  it("is done once all jobs are terminal, tallying each outcome", () => {
    const { done, state } = evaluateWaitBatch([
      job("completed", "a"),
      job("failed", "b"),
      job("cancelled", "c"),
      job("completed", "d"),
    ]);
    expect(done).toBe(true);
    expect(state).toEqual({ total: 4, pending: 0, completed: 2, failed: 1, cancelled: 1 });
  });
});

describe("waitBatchOutcome", () => {
  const state = (over: Partial<ReturnType<typeof evaluateWaitBatch>["state"]> = {}) => ({
    total: 0,
    pending: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    ...over,
  });

  it("an all-completed (or empty) batch is completed", () => {
    expect(waitBatchOutcome(state())).toBe("completed");
    expect(waitBatchOutcome(state({ total: 2, completed: 2 }))).toBe("completed");
  });

  it("failure dominates over completion and cancellation", () => {
    expect(waitBatchOutcome(state({ total: 3, completed: 1, failed: 1, cancelled: 1 }))).toBe("failed");
  });

  it("cancellation wins when there are no failures", () => {
    expect(waitBatchOutcome(state({ total: 2, completed: 1, cancelled: 1 }))).toBe("cancelled");
  });

  it("its outcomes map to the shared wait exit codes", () => {
    expect(waitExitCode(waitBatchOutcome(state({ completed: 1 })))).toBe(0);
    expect(waitExitCode(waitBatchOutcome(state({ failed: 1 })))).toBe(1);
    expect(waitExitCode(waitBatchOutcome(state({ cancelled: 1 })))).toBe(2);
  });
});
