import { describe, expect, it } from "vitest";
import type { JobStatus, RelayJob } from "../src/types.js";
import {
  evaluateWait,
  evaluateWaitAll,
  isTerminalStatus,
  WAIT_ALL_EXIT_CODES,
  WAIT_EXIT_CODES,
  waitAllExitCode,
  waitExitCode,
} from "../src/wait.js";

function job(status: JobStatus): RelayJob {
  return {
    id: "id",
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

describe("waitAllExitCode", () => {
  it("maps drained to 0 and timeout to 124", () => {
    expect(waitAllExitCode("drained")).toBe(0);
    expect(waitAllExitCode("timeout")).toBe(124);
  });

  it("WAIT_ALL_EXIT_CODES has an entry for every outcome", () => {
    expect(Object.keys(WAIT_ALL_EXIT_CODES).sort()).toEqual(["drained", "timeout"].sort());
  });

  it("shares the 124 timeout code with the per-job table", () => {
    expect(WAIT_ALL_EXIT_CODES.timeout).toBe(WAIT_EXIT_CODES.timeout);
  });
});

describe("evaluateWaitAll", () => {
  it("is drained for an empty list", () => {
    expect(evaluateWaitAll([])).toEqual({ active: 0, done: true });
  });

  it("is drained when every job is terminal", () => {
    const jobs = [job("completed"), job("failed"), job("cancelled")];
    expect(evaluateWaitAll(jobs)).toEqual({ active: 0, done: true });
  });

  it("counts non-terminal jobs as active and is not done", () => {
    const jobs = [job("queued"), job("waiting_for_reset"), job("resuming"), job("completed")];
    expect(evaluateWaitAll(jobs)).toEqual({ active: 3, done: false });
  });

  it("becomes done once the last active job settles", () => {
    expect(evaluateWaitAll([job("resuming")]).done).toBe(false);
    expect(evaluateWaitAll([job("completed")]).done).toBe(true);
  });
});
