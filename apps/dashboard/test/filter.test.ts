import type { JobStatus, RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { describeFilter, filterJobsByStatus, isFilterActive, toggleStatus } from "../lib/filter";

function job(id: string, status: JobStatus): RelayJob {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id,
    project: "proj",
    tool: "claude-code",
    command: ["claude", "-p", id],
    cwd: "/tmp",
    status,
    attempts: 0,
    resetAt: null,
    createdAt: now,
    updatedAt: now,
    lastError: null,
    lastOutputTail: null,
  } satisfies RelayJob;
}

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: "Queued",
  waiting_for_reset: "Waiting for reset",
  resuming: "Resuming",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const ORDER: JobStatus[] = ["queued", "waiting_for_reset", "resuming", "completed", "failed", "cancelled"];

describe("filterJobsByStatus", () => {
  const jobs = [job("a", "waiting_for_reset"), job("b", "completed"), job("c", "failed"), job("d", "completed")];

  it("returns the same array unchanged when the filter set is empty", () => {
    const active = new Set<JobStatus>();
    const result = filterJobsByStatus(jobs, active);
    expect(result).toBe(jobs);
  });

  it("keeps only jobs matching a single active status", () => {
    const result = filterJobsByStatus(jobs, new Set<JobStatus>(["completed"]));
    expect(result.map((j) => j.id)).toEqual(["b", "d"]);
  });

  it("ORs across multiple active statuses and preserves input order", () => {
    const result = filterJobsByStatus(jobs, new Set<JobStatus>(["failed", "waiting_for_reset"]));
    expect(result.map((j) => j.id)).toEqual(["a", "c"]);
  });

  it("returns an empty array when nothing matches", () => {
    const result = filterJobsByStatus(jobs, new Set<JobStatus>(["cancelled"]));
    expect(result).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const before = jobs.slice();
    filterJobsByStatus(jobs, new Set<JobStatus>(["completed"]));
    expect(jobs).toEqual(before);
  });
});

describe("toggleStatus", () => {
  it("adds a status that is absent", () => {
    const next = toggleStatus(new Set<JobStatus>(), "failed");
    expect([...next]).toEqual(["failed"]);
  });

  it("removes a status that is present", () => {
    const next = toggleStatus(new Set<JobStatus>(["failed", "completed"]), "failed");
    expect([...next]).toEqual(["completed"]);
  });

  it("never mutates the input set", () => {
    const active = new Set<JobStatus>(["failed"]);
    toggleStatus(active, "completed");
    expect([...active]).toEqual(["failed"]);
  });
});

describe("isFilterActive", () => {
  it("is false for an empty set and true otherwise", () => {
    expect(isFilterActive(new Set())).toBe(false);
    expect(isFilterActive(new Set<JobStatus>(["queued"]))).toBe(true);
  });
});

describe("describeFilter", () => {
  it("returns an empty string with no active statuses", () => {
    expect(describeFilter(new Set(), STATUS_LABELS, ORDER)).toBe("");
  });

  it("renders a single label", () => {
    expect(describeFilter(new Set<JobStatus>(["failed"]), STATUS_LABELS, ORDER)).toBe("Failed");
  });

  it("renders multiple labels in the fixed order, not set-insertion order", () => {
    const active = new Set<JobStatus>(["failed", "waiting_for_reset"]);
    expect(describeFilter(active, STATUS_LABELS, ORDER)).toBe("Waiting for reset, Failed");
  });
});
