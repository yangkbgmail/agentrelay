import { describe, expect, it } from "vitest";
import { summarizeJobs } from "../src/summary.js";
import type { RelayJob } from "../src/types.js";

function job(overrides: Partial<RelayJob>): RelayJob {
  return {
    id: "id",
    project: "proj",
    tool: "claude-code",
    command: ["echo"],
    cwd: "/tmp",
    status: "queued",
    resetAt: null,
    createdAt: "2026-07-12T10:00:00.000Z",
    updatedAt: "2026-07-12T10:00:00.000Z",
    attempts: 0,
    retryCount: 0,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("summarizeJobs", () => {
  it("returns zero counts and no next reset for an empty queue", () => {
    const summary = summarizeJobs([]);
    expect(summary.total).toBe(0);
    expect(summary.byStatus.waiting_for_reset).toBe(0);
    expect(summary.nextResetAt).toBeNull();
  });

  it("counts jobs by status", () => {
    const summary = summarizeJobs([
      job({ id: "a", status: "completed" }),
      job({ id: "b", status: "completed" }),
      job({ id: "c", status: "failed" }),
      job({ id: "d", status: "waiting_for_reset", resetAt: "2026-07-12T15:00:00.000Z" }),
    ]);
    expect(summary.total).toBe(4);
    expect(summary.byStatus.completed).toBe(2);
    expect(summary.byStatus.failed).toBe(1);
    expect(summary.byStatus.waiting_for_reset).toBe(1);
    expect(summary.byStatus.queued).toBe(0);
  });

  it("picks the earliest reset time among waiting jobs only", () => {
    const summary = summarizeJobs([
      job({ id: "a", status: "waiting_for_reset", resetAt: "2026-07-12T18:00:00.000Z" }),
      job({ id: "b", status: "waiting_for_reset", resetAt: "2026-07-12T15:00:00.000Z" }),
      // completed job with an old resetAt must not win
      job({ id: "c", status: "completed", resetAt: "2026-07-12T01:00:00.000Z" }),
    ]);
    expect(summary.nextResetAt).toBe("2026-07-12T15:00:00.000Z");
  });
});
