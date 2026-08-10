import { describe, expect, it } from "vitest";
import { DRAIN_EXIT_CODES, drainExitCode, evaluateDrain, isQueueDrained, summarizeDrain } from "./drain.js";
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
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("summarizeDrain", () => {
  it("reports an empty queue as fully drained (all counts zero)", () => {
    expect(summarizeDrain([])).toEqual({ total: 0, active: 0, completed: 0, failed: 0, cancelled: 0 });
  });

  it("buckets every status into active vs terminal totals", () => {
    const snapshot = summarizeDrain([
      job({ status: "queued" }),
      job({ status: "waiting_for_reset" }),
      job({ status: "resuming" }),
      job({ status: "completed" }),
      job({ status: "failed" }),
      job({ status: "cancelled" }),
    ]);
    expect(snapshot).toEqual({ total: 6, active: 3, completed: 1, failed: 1, cancelled: 1 });
  });
});

describe("isQueueDrained", () => {
  it("is true when no job is active", () => {
    expect(isQueueDrained([job({ status: "completed" }), job({ status: "failed" })])).toBe(true);
  });

  it("is true for an empty queue", () => {
    expect(isQueueDrained([])).toBe(true);
  });

  it("is false while any job is still active", () => {
    expect(isQueueDrained([job({ status: "completed" }), job({ status: "waiting_for_reset" })])).toBe(false);
  });
});

describe("evaluateDrain", () => {
  it("is not done while an active job remains", () => {
    const result = evaluateDrain([job({ status: "completed" }), job({ status: "queued" })]);
    expect(result.done).toBe(false);
    expect(result.outcome).toBeUndefined();
    expect(result.snapshot.active).toBe(1);
  });

  it("settles as drained once all jobs are terminal", () => {
    const result = evaluateDrain([job({ status: "completed" }), job({ status: "cancelled" })]);
    expect(result.done).toBe(true);
    expect(result.outcome).toBe("drained");
  });

  it("settles an empty queue as drained immediately", () => {
    expect(evaluateDrain([])).toEqual({
      done: true,
      outcome: "drained",
      snapshot: { total: 0, active: 0, completed: 0, failed: 0, cancelled: 0 },
    });
  });

  it("still settles as drained on failures without --fail-on-error", () => {
    const result = evaluateDrain([job({ status: "completed" }), job({ status: "failed" })]);
    expect(result.done).toBe(true);
    expect(result.outcome).toBe("drained");
  });

  it("settles as failed when --fail-on-error and a job failed", () => {
    const result = evaluateDrain([job({ status: "completed" }), job({ status: "failed" })], { failOnError: true });
    expect(result.done).toBe(true);
    expect(result.outcome).toBe("failed");
  });

  it("does not treat a cancelled job as a failure under --fail-on-error", () => {
    const result = evaluateDrain([job({ status: "completed" }), job({ status: "cancelled" })], { failOnError: true });
    expect(result.outcome).toBe("drained");
  });

  it("is still not done under --fail-on-error while active jobs remain (even with a failure present)", () => {
    const result = evaluateDrain([job({ status: "failed" }), job({ status: "resuming" })], { failOnError: true });
    expect(result.done).toBe(false);
    expect(result.outcome).toBeUndefined();
  });
});

describe("drainExitCode", () => {
  it("maps outcomes to conventional exit codes", () => {
    expect(drainExitCode("drained")).toBe(0);
    expect(drainExitCode("failed")).toBe(1);
    expect(drainExitCode("timeout")).toBe(124);
    expect(DRAIN_EXIT_CODES).toEqual({ drained: 0, failed: 1, timeout: 124 });
  });
});
