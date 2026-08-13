import { describe, expect, it } from "vitest";
import type { JobStatus, RelayJob } from "../src/types.js";
import { evaluateWait, evaluateWaitAll, isTerminalStatus, WAIT_EXIT_CODES, waitExitCode } from "../src/wait.js";

let seq = 0;
function job(status: JobStatus): RelayJob {
  seq += 1;
  return {
    id: `id-${seq}`,
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

describe("evaluateWaitAll", () => {
  it("reports an empty queue as vacuously drained + completed", () => {
    expect(evaluateWaitAll([])).toEqual({ done: true, outcome: "completed", remaining: 0, total: 0 });
  });

  it("is not done while any job is still active, counting the remainder", () => {
    const jobs = [job("completed"), job("waiting_for_reset"), job("resuming")];
    expect(evaluateWaitAll(jobs)).toEqual({ done: false, remaining: 2, total: 1 });
  });

  it("drains to completed when every job completed", () => {
    expect(evaluateWaitAll([job("completed"), job("completed")])).toEqual({
      done: true,
      outcome: "completed",
      remaining: 0,
      total: 2,
    });
  });

  it("aggregates cancelled over completed", () => {
    expect(evaluateWaitAll([job("completed"), job("cancelled")])).toEqual({
      done: true,
      outcome: "cancelled",
      remaining: 0,
      total: 2,
    });
  });

  it("aggregates failed as the worst outcome, over cancelled and completed", () => {
    expect(evaluateWaitAll([job("completed"), job("cancelled"), job("failed")])).toEqual({
      done: true,
      outcome: "failed",
      remaining: 0,
      total: 3,
    });
  });

  it("does not report done just because some jobs are terminal", () => {
    const verdict = evaluateWaitAll([job("failed"), job("queued")]);
    expect(verdict.done).toBe(false);
    expect(verdict.remaining).toBe(1);
  });
});
