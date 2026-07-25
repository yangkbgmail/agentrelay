import { describe, expect, it } from "vitest";
import type { JobStatus, RelayJob } from "../src/types.js";
import {
  aggregateWaitOutcomes,
  evaluateWait,
  evaluateWaitAll,
  isActiveStatus,
  isTerminalStatus,
  WAIT_EXIT_CODES,
  WAIT_OUTCOME_SEVERITY,
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

describe("isActiveStatus", () => {
  it("is true only for queued/waiting_for_reset/resuming", () => {
    expect(isActiveStatus("queued")).toBe(true);
    expect(isActiveStatus("waiting_for_reset")).toBe(true);
    expect(isActiveStatus("resuming")).toBe(true);
    expect(isActiveStatus("completed")).toBe(false);
    expect(isActiveStatus("failed")).toBe(false);
    expect(isActiveStatus("cancelled")).toBe(false);
  });
});

describe("aggregateWaitOutcomes", () => {
  it("returns completed for an empty batch (nothing was pending)", () => {
    expect(aggregateWaitOutcomes([])).toBe("completed");
  });

  it("returns completed only when every member completed", () => {
    expect(aggregateWaitOutcomes(["completed", "completed"])).toBe("completed");
  });

  it("picks the worst outcome by severity: timeout > failed > cancelled > missing > completed", () => {
    expect(aggregateWaitOutcomes(["completed", "failed"])).toBe("failed");
    expect(aggregateWaitOutcomes(["completed", "cancelled"])).toBe("cancelled");
    expect(aggregateWaitOutcomes(["completed", "missing"])).toBe("missing");
    expect(aggregateWaitOutcomes(["failed", "cancelled", "completed"])).toBe("failed");
    expect(aggregateWaitOutcomes(["missing", "cancelled"])).toBe("cancelled");
    expect(aggregateWaitOutcomes(["timeout", "failed"])).toBe("timeout");
  });

  it("severity table ranks every outcome and is a strict total order", () => {
    const ranks = Object.values(WAIT_OUTCOME_SEVERITY);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(WAIT_OUTCOME_SEVERITY.timeout).toBeGreaterThan(WAIT_OUTCOME_SEVERITY.failed);
    expect(WAIT_OUTCOME_SEVERITY.failed).toBeGreaterThan(WAIT_OUTCOME_SEVERITY.cancelled);
    expect(WAIT_OUTCOME_SEVERITY.cancelled).toBeGreaterThan(WAIT_OUTCOME_SEVERITY.missing);
    expect(WAIT_OUTCOME_SEVERITY.missing).toBeGreaterThan(WAIT_OUTCOME_SEVERITY.completed);
  });
});

describe("evaluateWaitAll", () => {
  it("is not done while any tracked job is still active, and reports pending count", () => {
    const verdict = evaluateWaitAll([job("completed"), job("queued"), job("resuming")]);
    expect(verdict.done).toBe(false);
    expect(verdict.pending).toBe(2);
    expect(verdict.outcomes).toEqual([]);
  });

  it("is done with per-job outcomes once every job is terminal or missing", () => {
    const verdict = evaluateWaitAll([job("completed"), job("failed"), null]);
    expect(verdict.done).toBe(true);
    expect(verdict.pending).toBe(0);
    expect(verdict.outcomes).toEqual(["completed", "failed", "missing"]);
  });

  it("an empty tracked set is trivially done with no outcomes", () => {
    expect(evaluateWaitAll([])).toEqual({ done: true, outcomes: [], pending: 0 });
  });
});
