import { describe, expect, it } from "vitest";
import { computeQueueEta } from "./eta.js";
import type { AgentTool, JobStatus, RelayJob } from "./types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "proj",
    tool: "claude-code" as AgentTool,
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "waiting_for_reset" as JobStatus,
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-13T12:00:00.000Z");

describe("computeQueueEta", () => {
  it("returns null for an empty store", () => {
    expect(computeQueueEta([], NOW)).toBeNull();
  });

  it("returns null when no job is waiting for a reset", () => {
    const jobs = [
      job({ status: "completed", resetAt: null }),
      job({ status: "queued", resetAt: null }),
      job({ status: "resuming", resetAt: "2026-07-13T13:00:00.000Z" }),
    ];
    expect(computeQueueEta(jobs, NOW)).toBeNull();
  });

  it("ignores waiting jobs with an unparseable resetAt", () => {
    const jobs = [job({ resetAt: "not-a-date" }), job({ resetAt: "2026-07-13T14:00:00.000Z" })];
    const eta = computeQueueEta(jobs, NOW);
    expect(eta).not.toBeNull();
    expect(eta?.waitingCount).toBe(1);
    expect(eta?.firstResetAt).toBe("2026-07-13T14:00:00.000Z");
    expect(eta?.lastResetAt).toBe("2026-07-13T14:00:00.000Z");
  });

  it("reports first and last reset for a spread of waiting jobs", () => {
    const jobs = [
      job({ resetAt: "2026-07-13T15:00:00.000Z" }),
      job({ resetAt: "2026-07-13T13:00:00.000Z" }),
      job({ resetAt: "2026-07-13T14:00:00.000Z" }),
    ];
    const eta = computeQueueEta(jobs, NOW);
    expect(eta?.waitingCount).toBe(3);
    expect(eta?.firstResetAt).toBe("2026-07-13T13:00:00.000Z");
    expect(eta?.firstDueInMs).toBe(60 * 60 * 1000);
    expect(eta?.lastResetAt).toBe("2026-07-13T15:00:00.000Z");
    expect(eta?.lastDueInMs).toBe(3 * 60 * 60 * 1000);
    expect(eta?.dueNow).toBe(0);
    expect(eta?.allDue).toBe(false);
  });

  it("counts already-due jobs and reports negative dueInMs", () => {
    const jobs = [
      job({ resetAt: "2026-07-13T11:00:00.000Z" }), // past
      job({ resetAt: "2026-07-13T11:30:00.000Z" }), // past
      job({ resetAt: "2026-07-13T13:00:00.000Z" }), // future
    ];
    const eta = computeQueueEta(jobs, NOW);
    expect(eta?.waitingCount).toBe(3);
    expect(eta?.dueNow).toBe(2);
    expect(eta?.firstDueInMs).toBe(-60 * 60 * 1000);
    expect(eta?.allDue).toBe(false);
  });

  it("marks allDue when every waiting job's reset has passed", () => {
    const jobs = [job({ resetAt: "2026-07-13T10:00:00.000Z" }), job({ resetAt: "2026-07-13T11:00:00.000Z" })];
    const eta = computeQueueEta(jobs, NOW);
    expect(eta?.dueNow).toBe(2);
    expect(eta?.allDue).toBe(true);
    expect(eta?.lastDueInMs).toBeLessThanOrEqual(0);
  });

  it("treats a single waiting job as first === last", () => {
    const jobs = [job({ resetAt: "2026-07-13T16:00:00.000Z" })];
    const eta = computeQueueEta(jobs, NOW);
    expect(eta?.waitingCount).toBe(1);
    expect(eta?.firstResetAt).toBe(eta?.lastResetAt);
    expect(eta?.firstDueInMs).toBe(eta?.lastDueInMs);
  });

  it("preserves the raw resetAt string (timezone offsets not normalized)", () => {
    const jobs = [job({ resetAt: "2026-07-13T22:00:00.000+09:00" })];
    const eta = computeQueueEta(jobs, NOW);
    expect(eta?.firstResetAt).toBe("2026-07-13T22:00:00.000+09:00");
  });
});
