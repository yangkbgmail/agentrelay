import type { DrainSnapshot, RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { drainQueue } from "./commands.js";
import { drainMessage, renderDrainJson } from "./drain.js";

function snapshot(overrides: Partial<DrainSnapshot> = {}): DrainSnapshot {
  return { total: 0, active: 0, completed: 0, failed: 0, cancelled: 0, ...overrides };
}

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

describe("drainMessage", () => {
  it("calls an empty queue empty", () => {
    expect(drainMessage("drained", snapshot())).toBe("queue is empty — nothing to drain");
  });

  it("summarizes a settled queue with per-status counts", () => {
    const msg = drainMessage("drained", snapshot({ total: 3, completed: 2, failed: 1 }));
    expect(msg).toBe("queue drained: 3 jobs settled (2 completed, 1 failed)");
  });

  it("uses singular phrasing for one settled job", () => {
    expect(drainMessage("drained", snapshot({ total: 1, completed: 1 }))).toBe(
      "queue drained: 1 job settled (1 completed)"
    );
  });

  it("flags failures for the failed outcome", () => {
    expect(drainMessage("failed", snapshot({ total: 2, completed: 1, failed: 1 }))).toBe(
      "queue drained but 1 job failed (1 completed, 1 failed)"
    );
  });

  it("reports still-active jobs on a timeout", () => {
    expect(drainMessage("timeout", snapshot({ total: 3, active: 2, completed: 1 }))).toBe(
      "timed out with 2 jobs still active (1 completed)"
    );
  });
});

describe("renderDrainJson", () => {
  it("emits the outcome, exit code, and snapshot in a stable envelope", () => {
    const json = renderDrainJson(
      { outcome: "drained", snapshot: snapshot({ total: 1, completed: 1 }), exitCode: 0 },
      "/x/jobs.json",
      "2026-07-30T10:00:00.000Z"
    );
    expect(JSON.parse(json)).toEqual({
      storePath: "/x/jobs.json",
      generatedAt: "2026-07-30T10:00:00.000Z",
      outcome: "drained",
      exitCode: 0,
      snapshot: { total: 1, active: 0, completed: 1, failed: 0, cancelled: 0 },
    });
  });
});

describe("drainQueue", () => {
  it("returns immediately when the queue is already settled", async () => {
    let reads = 0;
    const result = await drainQueue({
      readJobs: () => {
        reads += 1;
        return [job({ status: "completed" }), job({ status: "failed" })];
      },
      sleep: async () => {
        throw new Error("should not sleep on an already-drained queue");
      },
    });
    expect(reads).toBe(1);
    expect(result.outcome).toBe("drained");
    expect(result.exitCode).toBe(0);
    expect(result.snapshot.active).toBe(0);
  });

  it("polls until the last active job settles", async () => {
    // Active for the first two reads, then everything terminal.
    const frames: RelayJob[][] = [
      [job({ status: "completed" }), job({ status: "waiting_for_reset" })],
      [job({ status: "completed" }), job({ status: "resuming" })],
      [job({ status: "completed" }), job({ status: "completed" })],
    ];
    let i = 0;
    let sleeps = 0;
    const result = await drainQueue({
      readJobs: () => frames[Math.min(i, frames.length - 1)],
      sleep: async () => {
        sleeps += 1;
        i += 1;
      },
      intervalMs: 1,
    });
    expect(sleeps).toBe(2);
    expect(result.outcome).toBe("drained");
    expect(result.exitCode).toBe(0);
  });

  it("times out (exit 124) when the queue never drains", async () => {
    let clock = 0;
    const result = await drainQueue({
      readJobs: () => [job({ status: "waiting_for_reset" })],
      now: () => clock,
      sleep: async () => {
        clock += 5;
      },
      intervalMs: 5,
      timeoutMs: 8,
    });
    expect(result.outcome).toBe("timeout");
    expect(result.exitCode).toBe(124);
    expect(result.snapshot.active).toBe(1);
  });

  it("settles as failed (exit 1) under failOnError when a job failed", async () => {
    const result = await drainQueue({
      readJobs: () => [job({ status: "completed" }), job({ status: "failed" })],
      failOnError: true,
      sleep: async () => {},
    });
    expect(result.outcome).toBe("failed");
    expect(result.exitCode).toBe(1);
  });
});
