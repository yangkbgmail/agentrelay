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
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("summarizeDrain", () => {
  it("returns an all-zero shape for no jobs", () => {
    expect(summarizeDrain([])).toEqual({ total: 0, active: 0, completed: 0, failed: 0, cancelled: 0 });
  });

  it("counts active statuses (queued/waiting_for_reset/resuming) together", () => {
    const snapshot = summarizeDrain([
      job({ status: "queued" }),
      job({ status: "waiting_for_reset" }),
      job({ status: "resuming" }),
    ]);
    expect(snapshot).toEqual({ total: 3, active: 3, completed: 0, failed: 0, cancelled: 0 });
  });

  it("counts each terminal status separately", () => {
    const snapshot = summarizeDrain([
      job({ status: "completed" }),
      job({ status: "completed" }),
      job({ status: "failed" }),
      job({ status: "cancelled" }),
    ]);
    expect(snapshot).toEqual({ total: 4, active: 0, completed: 2, failed: 1, cancelled: 1 });
  });

  it("does not mutate the input array", () => {
    const jobs = [job({ status: "queued" }), job({ status: "completed" })];
    const before = jobs.slice();
    summarizeDrain(jobs);
    expect(jobs).toEqual(before);
  });
});

describe("evaluateDrain", () => {
  it("is empty (done, exit 0) for an empty scope", () => {
    const verdict = evaluateDrain([]);
    expect(verdict.done).toBe(true);
    expect(verdict.outcome).toBe("empty");
    expect(drainExitCode("empty")).toBe(0);
  });

  it("is not done while any job is still active", () => {
    const verdict = evaluateDrain([job({ status: "completed" }), job({ status: "waiting_for_reset" })]);
    expect(verdict.done).toBe(false);
    expect(verdict.outcome).toBeUndefined();
    expect(verdict.snapshot.active).toBe(1);
  });

  it("completes (exit 0) when every scoped job finished cleanly", () => {
    const verdict = evaluateDrain([job({ status: "completed" }), job({ status: "completed" })]);
    expect(verdict.done).toBe(true);
    expect(verdict.outcome).toBe("completed");
    expect(drainExitCode("completed")).toBe(0);
  });

  it("reports failed (exit 1) when any terminal job failed — failure wins over cancelled", () => {
    const verdict = evaluateDrain([
      job({ status: "completed" }),
      job({ status: "cancelled" }),
      job({ status: "failed" }),
    ]);
    expect(verdict.outcome).toBe("failed");
    expect(drainExitCode("failed")).toBe(1);
  });

  it("reports cancelled (exit 2) when some were cancelled but none failed", () => {
    const verdict = evaluateDrain([job({ status: "completed" }), job({ status: "cancelled" })]);
    expect(verdict.outcome).toBe("cancelled");
    expect(drainExitCode("cancelled")).toBe(2);
  });
});

describe("DRAIN_EXIT_CODES", () => {
  it("maps outcomes to conventional exit codes (124 = timeout, GNU coreutils)", () => {
    expect(DRAIN_EXIT_CODES).toEqual({ empty: 0, completed: 0, failed: 1, cancelled: 2, timeout: 124 });
  });
});
