import type { RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { type WaitAllResult, waitForAll } from "./commands.js";
import { renderWaitAllJson } from "./wait.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "queued",
    resetAt: null,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("waitForAll", () => {
  it("returns immediately when the queue is already drained", async () => {
    let reads = 0;
    let slept = 0;
    const result = await waitForAll({
      readJobs: () => {
        reads += 1;
        return [job({ status: "completed" }), job({ status: "completed" })];
      },
      sleep: async () => {
        slept += 1;
      },
      now: () => 0,
    });
    expect(result.outcome).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.total).toBe(2);
    expect(reads).toBe(1);
    expect(slept).toBe(0);
  });

  it("polls until the last active job settles, then aggregates the worst outcome", async () => {
    // Snapshots a separate daemon would produce over time: one job stays active
    // for two polls, then everything is terminal with a failure present.
    const snapshots: RelayJob[][] = [
      [job({ id: "a", status: "completed" }), job({ id: "b", status: "resuming" })],
      [job({ id: "a", status: "completed" }), job({ id: "b", status: "waiting_for_reset" })],
      [job({ id: "a", status: "completed" }), job({ id: "b", status: "failed" })],
    ];
    let i = 0;
    let elapsed = 0;
    const polls: number[] = [];
    const result = await waitForAll({
      intervalMs: 1000,
      readJobs: () => snapshots[Math.min(i, snapshots.length - 1)],
      sleep: async () => {
        i += 1;
        elapsed += 1000;
      },
      now: () => elapsed,
      onPoll: (verdict) => polls.push(verdict.remaining),
    });
    expect(result.outcome).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.total).toBe(2);
    // Two polls saw one still-active job before it drained.
    expect(polls).toEqual([1, 1]);
  });

  it("times out with exit 124 while jobs are still active", async () => {
    let elapsed = 0;
    const result = await waitForAll({
      intervalMs: 1000,
      timeoutMs: 2000,
      readJobs: () => [job({ status: "waiting_for_reset" }), job({ status: "completed" })],
      sleep: async () => {
        elapsed += 1000;
      },
      now: () => elapsed,
    });
    expect(result.outcome).toBe("timeout");
    expect(result.exitCode).toBe(124);
    expect(result.remaining).toBe(1);
  });
});

describe("renderWaitAllJson", () => {
  it("emits the aggregate shape scripts branch on", () => {
    const result: WaitAllResult = {
      outcome: "failed",
      remaining: 0,
      total: 3,
      message: "queue drained with failure(s) across 3 job(s)",
      exitCode: 1,
    };
    const parsed = JSON.parse(renderWaitAllJson(result, "/x/jobs.json", "2026-08-13T10:00:00.000Z"));
    expect(parsed).toEqual({
      storePath: "/x/jobs.json",
      generatedAt: "2026-08-13T10:00:00.000Z",
      outcome: "failed",
      exitCode: 1,
      total: 3,
      remaining: 0,
    });
  });
});
