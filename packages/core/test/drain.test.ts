import { describe, expect, it } from "vitest";
import {
  DRAIN_EXIT_CODES,
  type DrainState,
  drainExitCode,
  drainOutcome,
  evaluateDrain,
  isActiveStatus,
} from "../src/drain.js";
import type { JobStatus, RelayJob } from "../src/types.js";

function job(status: JobStatus, id = "id"): RelayJob {
  return {
    id,
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

describe("drainExitCode", () => {
  it("maps each outcome to its documented exit code", () => {
    expect(drainExitCode("empty")).toBe(0);
    expect(drainExitCode("drained")).toBe(0);
    expect(drainExitCode("drained_with_failures")).toBe(1);
    expect(drainExitCode("timeout")).toBe(124);
  });

  it("DRAIN_EXIT_CODES has an entry for every outcome", () => {
    expect(Object.keys(DRAIN_EXIT_CODES).sort()).toEqual(
      ["drained", "drained_with_failures", "empty", "timeout"].sort()
    );
  });
});

describe("evaluateDrain", () => {
  it("an empty store is already done", () => {
    expect(evaluateDrain([])).toEqual({ active: 0, terminal: 0, failed: 0, total: 0, done: true });
  });

  it("counts active vs terminal and is not done while any job is active", () => {
    const state = evaluateDrain([
      job("queued", "a"),
      job("waiting_for_reset", "b"),
      job("resuming", "c"),
      job("completed", "d"),
    ]);
    expect(state).toEqual({ active: 3, terminal: 1, failed: 0, total: 4, done: false });
  });

  it("is done once only terminal jobs remain, tallying failures", () => {
    const state = evaluateDrain([job("completed", "a"), job("failed", "b"), job("cancelled", "c")]);
    expect(state).toEqual({ active: 0, terminal: 3, failed: 1, total: 3, done: true });
  });
});

describe("drainOutcome", () => {
  const drained: DrainState = { active: 0, terminal: 2, failed: 0, total: 2, done: true };
  const withFailures: DrainState = { active: 0, terminal: 2, failed: 1, total: 2, done: true };
  const empty: DrainState = { active: 0, terminal: 0, failed: 0, total: 0, done: true };
  const pending: DrainState = { active: 1, terminal: 0, failed: 0, total: 1, done: false };

  it("reports empty for a store with no jobs", () => {
    expect(drainOutcome(empty)).toBe("empty");
  });

  it("reports drained when everything settled cleanly", () => {
    expect(drainOutcome(drained)).toBe("drained");
  });

  it("reports drained_with_failures when any terminal job failed", () => {
    expect(drainOutcome(withFailures)).toBe("drained_with_failures");
  });

  it("reports timeout only while jobs are still active", () => {
    expect(drainOutcome(pending, { timedOut: true })).toBe("timeout");
  });

  it("a queue that settled exactly at the deadline still counts as drained, not timeout", () => {
    expect(drainOutcome(drained, { timedOut: true })).toBe("drained");
    expect(drainOutcome(withFailures, { timedOut: true })).toBe("drained_with_failures");
  });
});
