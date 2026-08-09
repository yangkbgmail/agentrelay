import { describe, expect, it } from "vitest";
import { DRAIN_EXIT_CODES, drainExitCode, evaluateDrain, summarizeDrain } from "./drain.js";
import type { RelayJob } from "./types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "waiting_for_reset",
    resetAt: "2026-07-30T12:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("summarizeDrain", () => {
  it("reports an all-zero snapshot for an empty queue", () => {
    expect(summarizeDrain([])).toEqual({ total: 0, active: 0, completed: 0, failed: 0, cancelled: 0 });
  });

  it("counts all three active states as active", () => {
    const snapshot = summarizeDrain([
      job({ status: "queued" }),
      job({ status: "waiting_for_reset" }),
      job({ status: "resuming" }),
    ]);
    expect(snapshot.active).toBe(3);
    expect(snapshot.total).toBe(3);
  });

  it("splits the terminal states apart", () => {
    const snapshot = summarizeDrain([
      job({ status: "completed" }),
      job({ status: "completed" }),
      job({ status: "failed" }),
      job({ status: "cancelled" }),
    ]);
    expect(snapshot).toEqual({ total: 4, active: 0, completed: 2, failed: 1, cancelled: 1 });
  });

  it("counts a mixed queue", () => {
    const snapshot = summarizeDrain([
      job({ status: "queued" }),
      job({ status: "completed" }),
      job({ status: "failed" }),
    ]);
    expect(snapshot).toEqual({ total: 3, active: 1, completed: 1, failed: 1, cancelled: 0 });
  });
});

describe("evaluateDrain", () => {
  it("is done on an empty queue", () => {
    const { done, snapshot } = evaluateDrain([]);
    expect(done).toBe(true);
    expect(snapshot.active).toBe(0);
  });

  it("is not done while any job is active", () => {
    const { done } = evaluateDrain([job({ status: "completed" }), job({ status: "waiting_for_reset" })]);
    expect(done).toBe(false);
  });

  it("is done once every job is terminal, whatever the outcomes", () => {
    const { done, snapshot } = evaluateDrain([
      job({ status: "completed" }),
      job({ status: "failed" }),
      job({ status: "cancelled" }),
    ]);
    expect(done).toBe(true);
    expect(snapshot.active).toBe(0);
  });
});

describe("drainExitCode", () => {
  it("maps timeout to 124 regardless of failOnError", () => {
    const snapshot = summarizeDrain([job({ status: "queued" })]);
    expect(drainExitCode("timeout", snapshot)).toBe(DRAIN_EXIT_CODES.timeout);
    expect(drainExitCode("timeout", snapshot, true)).toBe(124);
  });

  it("maps a clean drain to 0", () => {
    const snapshot = summarizeDrain([job({ status: "completed" }), job({ status: "cancelled" })]);
    expect(drainExitCode("drained", snapshot)).toBe(0);
    expect(drainExitCode("drained", snapshot, true)).toBe(0);
  });

  it("exits 1 on a drained queue with a failure only when failOnError is set", () => {
    const snapshot = summarizeDrain([job({ status: "completed" }), job({ status: "failed" })]);
    expect(drainExitCode("drained", snapshot)).toBe(0);
    expect(drainExitCode("drained", snapshot, true)).toBe(1);
  });
});
