import { describe, expect, it } from "vitest";
import type { JobStatus, RelayJob } from "../src/types.js";
import {
  evaluateWait,
  isTerminalStatus,
  isWaitAllDone,
  tallyWaitAll,
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

describe("tallyWaitAll", () => {
  it("returns an all-zero tally for an empty set", () => {
    expect(tallyWaitAll([])).toEqual({ pending: 0, completed: 0, failed: 0, cancelled: 0, missing: 0 });
  });

  it("buckets each snapshot by its state, counting null as missing", () => {
    const tally = tallyWaitAll([
      job("queued"),
      job("waiting_for_reset"),
      job("resuming"),
      job("completed"),
      job("completed"),
      job("failed"),
      job("cancelled"),
      null,
    ]);
    expect(tally).toEqual({ pending: 3, completed: 2, failed: 1, cancelled: 1, missing: 1 });
  });
});

describe("isWaitAllDone", () => {
  it("is done only when nothing is still pending", () => {
    expect(isWaitAllDone(tallyWaitAll([job("completed"), null]))).toBe(true);
    expect(isWaitAllDone(tallyWaitAll([job("queued")]))).toBe(false);
  });
});

describe("waitAllExitCode", () => {
  it("returns 124 when timed out with jobs still pending", () => {
    expect(waitAllExitCode(tallyWaitAll([job("queued"), job("completed")]), true)).toBe(124);
  });

  it("ignores the timeout flag once everything has settled", () => {
    expect(waitAllExitCode(tallyWaitAll([job("completed"), job("completed")]), true)).toBe(0);
  });

  it("prefers failure (1) over cancellation (2) over clean (0)", () => {
    expect(waitAllExitCode(tallyWaitAll([job("failed"), job("cancelled")]), false)).toBe(1);
    expect(waitAllExitCode(tallyWaitAll([job("cancelled"), job("completed")]), false)).toBe(2);
    expect(waitAllExitCode(tallyWaitAll([job("completed")]), false)).toBe(0);
  });

  it("treats a vanished job as benign — missing alone never raises the code", () => {
    expect(waitAllExitCode(tallyWaitAll([null, job("completed")]), false)).toBe(0);
    expect(waitAllExitCode(tallyWaitAll([null]), false)).toBe(0);
  });
});
