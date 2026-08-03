import { describe, expect, it } from "vitest";
import type { JobStatus, RelayJob } from "./types.js";
import {
  isActiveStatus,
  resolveWaitAllOutcome,
  summarizeWaitAll,
  WAITALL_EXIT_CODES,
  type WaitAllProgress,
  waitAllExitCode,
} from "./waitall.js";

let seq = 0;
function job(status: JobStatus, overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status,
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("isActiveStatus", () => {
  it("treats queued/waiting_for_reset/resuming as active", () => {
    expect(isActiveStatus("queued")).toBe(true);
    expect(isActiveStatus("waiting_for_reset")).toBe(true);
    expect(isActiveStatus("resuming")).toBe(true);
  });
  it("treats terminal statuses as not active", () => {
    expect(isActiveStatus("completed")).toBe(false);
    expect(isActiveStatus("failed")).toBe(false);
    expect(isActiveStatus("cancelled")).toBe(false);
  });
});

describe("summarizeWaitAll", () => {
  it("returns an all-zero, done shape for no jobs", () => {
    expect(summarizeWaitAll([])).toEqual({
      total: 0,
      active: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      done: true,
    });
  });

  it("tallies active and terminal buckets disjointly", () => {
    const progress = summarizeWaitAll([
      job("queued"),
      job("waiting_for_reset"),
      job("resuming"),
      job("completed"),
      job("failed"),
      job("cancelled"),
    ]);
    expect(progress).toEqual({
      total: 6,
      active: 3,
      completed: 1,
      failed: 1,
      cancelled: 1,
      done: false,
    });
    // Buckets partition total (all statuses here are known).
    expect(progress.active + progress.completed + progress.failed + progress.cancelled).toBe(progress.total);
  });

  it("is done once nothing is active", () => {
    const progress = summarizeWaitAll([job("completed"), job("failed"), job("cancelled")]);
    expect(progress.active).toBe(0);
    expect(progress.done).toBe(true);
  });

  it("stays active while any job is still in flight", () => {
    expect(summarizeWaitAll([job("completed"), job("waiting_for_reset")]).done).toBe(false);
  });
});

describe("resolveWaitAllOutcome", () => {
  const p = (over: Partial<WaitAllProgress>): WaitAllProgress => ({
    total: 1,
    active: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    done: true,
    ...over,
  });

  it("reports empty when nothing is in scope", () => {
    expect(resolveWaitAllOutcome(p({ total: 0, done: true }), false)).toBe("empty");
    // Even a passed deadline over an empty scope is 'empty', not 'timeout'.
    expect(resolveWaitAllOutcome(p({ total: 0, done: true }), true)).toBe("empty");
  });

  it("reports all-completed when every settled job completed", () => {
    expect(resolveWaitAllOutcome(p({ total: 2, completed: 2 }), false)).toBe("all-completed");
  });

  it("lets failure dominate cancellation and completion", () => {
    expect(resolveWaitAllOutcome(p({ total: 3, completed: 1, failed: 1, cancelled: 1 }), false)).toBe("some-failed");
  });

  it("reports some-cancelled when no failures but a cancellation", () => {
    expect(resolveWaitAllOutcome(p({ total: 2, completed: 1, cancelled: 1 }), false)).toBe("some-cancelled");
  });

  it("reports timeout only while still active at the deadline", () => {
    expect(resolveWaitAllOutcome(p({ total: 2, active: 1, completed: 1, done: false }), true)).toBe("timeout");
  });

  it("reports the real outcome when the batch settles exactly at the deadline", () => {
    // timedOut true but done true -> not a spurious timeout.
    expect(resolveWaitAllOutcome(p({ total: 1, failed: 1, done: true }), true)).toBe("some-failed");
    expect(resolveWaitAllOutcome(p({ total: 1, completed: 1, done: true }), true)).toBe("all-completed");
  });
});

describe("waitAllExitCode", () => {
  it("maps outcomes to shell-friendly codes", () => {
    expect(waitAllExitCode("empty")).toBe(0);
    expect(waitAllExitCode("all-completed")).toBe(0);
    expect(waitAllExitCode("some-failed")).toBe(1);
    expect(waitAllExitCode("some-cancelled")).toBe(2);
    expect(waitAllExitCode("timeout")).toBe(124);
  });

  it("keeps the table and helper in sync", () => {
    for (const [outcome, code] of Object.entries(WAITALL_EXIT_CODES)) {
      expect(waitAllExitCode(outcome as keyof typeof WAITALL_EXIT_CODES)).toBe(code);
    }
  });
});
