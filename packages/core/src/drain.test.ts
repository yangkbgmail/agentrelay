import { describe, expect, it } from "vitest";
import { DRAIN_EXIT_CODES, drainExitCode, evaluateDrain } from "./drain.js";
import type { JobStatus, RelayJob } from "./types.js";

function job(status: JobStatus, id: string = status): RelayJob {
  return {
    id,
    project: "p",
    tool: "claude-code",
    command: ["claude"],
    cwd: "/tmp",
    status,
    resetAt: status === "waiting_for_reset" ? new Date().toISOString() : null,
    attempts: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastError: null,
    lastOutputTail: null,
    lastRateLimit: null,
  };
}

describe("evaluateDrain", () => {
  it("reports drained for an empty queue", () => {
    const p = evaluateDrain([]);
    expect(p.done).toBe(true);
    expect(p.active).toBe(0);
    expect(p.outcome).toBe("drained");
  });

  it("reports drained when only terminal jobs remain", () => {
    const p = evaluateDrain([job("completed", "a"), job("failed", "b"), job("cancelled", "c")]);
    expect(p.done).toBe(true);
    expect(p.active).toBe(0);
    expect(p.queued).toBe(0);
    expect(p.waiting).toBe(0);
    expect(p.resuming).toBe(0);
    expect(p.outcome).toBe("drained");
  });

  it("counts active jobs by status while draining", () => {
    const jobs = [
      job("queued", "q1"),
      job("queued", "q2"),
      job("waiting_for_reset", "w1"),
      job("resuming", "r1"),
      job("completed", "done"),
      job("failed", "err"),
    ];
    const p = evaluateDrain(jobs);
    expect(p.done).toBe(false);
    expect(p.active).toBe(4);
    expect(p.queued).toBe(2);
    expect(p.waiting).toBe(1);
    expect(p.resuming).toBe(1);
    expect(p.outcome).toBeUndefined();
  });

  it("treats each active status as still in flight", () => {
    for (const status of ["queued", "waiting_for_reset", "resuming"] as JobStatus[]) {
      const p = evaluateDrain([job(status)]);
      expect(p.done).toBe(false);
      expect(p.active).toBe(1);
    }
  });

  it("does not mutate the input array", () => {
    const jobs = [job("queued"), job("completed")];
    const snapshot = jobs.slice();
    evaluateDrain(jobs);
    expect(jobs).toEqual(snapshot);
  });
});

describe("drain exit codes", () => {
  it("maps outcomes to codes (drained 0, timeout 124)", () => {
    expect(drainExitCode("drained")).toBe(0);
    expect(drainExitCode("timeout")).toBe(124);
  });

  it("keeps the timeout code aligned with `wait`'s GNU timeout(1) convention", () => {
    expect(DRAIN_EXIT_CODES.timeout).toBe(124);
    expect(DRAIN_EXIT_CODES.drained).toBe(0);
  });
});
