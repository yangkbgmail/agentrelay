import { describe, expect, it } from "vitest";
import { findDuplicateJobs } from "./dedup.js";
import type { RelayJob } from "./types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp/alpha",
    status: "waiting_for_reset",
    resetAt: "2026-07-13T18:00:00.000Z",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("findDuplicateJobs", () => {
  it("returns an empty report for no jobs", () => {
    expect(findDuplicateJobs([])).toEqual({
      groups: [],
      groupCount: 0,
      duplicateJobs: 0,
      redundantJobs: 0,
    });
  });

  it("finds a cluster of two identical active jobs", () => {
    const report = findDuplicateJobs([
      job({ id: "a", createdAt: "2026-07-13T00:00:00.000Z" }),
      job({ id: "b", createdAt: "2026-07-13T01:00:00.000Z" }),
    ]);
    expect(report.groupCount).toBe(1);
    expect(report.duplicateJobs).toBe(2);
    expect(report.redundantJobs).toBe(1);
    const group = report.groups[0];
    expect(group.count).toBe(2);
    expect(group.redundant).toBe(1);
    // oldest createdAt is the keeper and comes first
    expect(group.jobs.map((j) => j.id)).toEqual(["a", "b"]);
  });

  it("does not group jobs that differ in command, cwd, or tool", () => {
    const report = findDuplicateJobs([
      job({ id: "a", command: ["claude", "-p", "one"] }),
      job({ id: "b", command: ["claude", "-p", "two"] }),
      job({ id: "c", command: ["claude", "-p", "one"], cwd: "/tmp/other" }),
      job({ id: "d", command: ["claude", "-p", "one"], tool: "codex-cli" }),
    ]);
    expect(report.groupCount).toBe(0);
    expect(report.redundantJobs).toBe(0);
  });

  it("ignores terminal jobs — only pending resumes can duplicate", () => {
    const report = findDuplicateJobs([
      job({ id: "a", status: "completed" }),
      job({ id: "b", status: "failed" }),
      job({ id: "c", status: "cancelled" }),
      // only one active job with this signature → not a duplicate
      job({ id: "d", status: "queued" }),
    ]);
    expect(report.groupCount).toBe(0);
  });

  it("groups mixed active statuses that share a signature", () => {
    const report = findDuplicateJobs([
      job({ id: "a", status: "queued" }),
      job({ id: "b", status: "waiting_for_reset" }),
      job({ id: "c", status: "resuming" }),
    ]);
    expect(report.groupCount).toBe(1);
    expect(report.groups[0].count).toBe(3);
    expect(report.groups[0].redundant).toBe(2);
    expect(report.redundantJobs).toBe(2);
  });

  it("skips jobs with an empty command (no work to duplicate)", () => {
    const report = findDuplicateJobs([
      job({ id: "a", command: [], status: "queued" }),
      job({ id: "b", command: [], status: "queued" }),
    ]);
    expect(report.groupCount).toBe(0);
  });

  it("does not collide ['a b'] with ['a', 'b']", () => {
    const report = findDuplicateJobs([
      job({ id: "a", command: ["a b"], status: "queued" }),
      job({ id: "b", command: ["a", "b"], status: "queued" }),
    ]);
    expect(report.groupCount).toBe(0);
  });

  it("picks the earliest waiting resetAt as the cluster's nextResetAt", () => {
    const report = findDuplicateJobs([
      job({ id: "a", status: "waiting_for_reset", resetAt: "2026-07-13T20:00:00.000Z" }),
      job({ id: "b", status: "waiting_for_reset", resetAt: "2026-07-13T15:00:00.000Z" }),
      // a resetAt on a non-waiting job in the group must not count
      job({ id: "c", status: "resuming", resetAt: "2026-07-13T09:00:00.000Z" }),
    ]);
    expect(report.groups[0].nextResetAt).toBe("2026-07-13T15:00:00.000Z");
  });

  it("leaves nextResetAt null when no clone is waiting", () => {
    const report = findDuplicateJobs([
      job({ id: "a", status: "queued", resetAt: null }),
      job({ id: "b", status: "resuming", resetAt: null }),
    ]);
    expect(report.groups[0].nextResetAt).toBeNull();
  });

  it("ranks clusters by redundant desc, then command asc for ties", () => {
    const report = findDuplicateJobs([
      // cluster X: command ["claude","-p","x"], 2 clones → 1 redundant
      job({ id: "x1", command: ["claude", "-p", "x"], cwd: "/x", status: "queued" }),
      job({ id: "x2", command: ["claude", "-p", "x"], cwd: "/x", status: "queued" }),
      // cluster Y: command ["claude","-p","y"], 3 clones → 2 redundant (should rank first)
      job({ id: "y1", command: ["claude", "-p", "y"], cwd: "/y", status: "queued" }),
      job({ id: "y2", command: ["claude", "-p", "y"], cwd: "/y", status: "queued" }),
      job({ id: "y3", command: ["claude", "-p", "y"], cwd: "/y", status: "queued" }),
    ]);
    expect(report.groupCount).toBe(2);
    expect(report.groups[0].redundant).toBe(2); // Y first (more redundant)
    expect(report.groups[0].command).toEqual(["claude", "-p", "y"]);
    expect(report.groups[1].redundant).toBe(1);
    expect(report.redundantJobs).toBe(3);
    expect(report.duplicateJobs).toBe(5);
  });

  it("keeps the oldest job first within a cluster (id tiebreak on equal createdAt)", () => {
    const report = findDuplicateJobs([
      job({ id: "zzz", status: "queued", createdAt: "2026-07-13T00:00:00.000Z" }),
      job({ id: "aaa", status: "queued", createdAt: "2026-07-13T00:00:00.000Z" }),
    ]);
    expect(report.groups[0].jobs.map((j) => j.id)).toEqual(["aaa", "zzz"]);
  });

  it("does not mutate the input array", () => {
    const jobs = [job({ id: "a", status: "queued" }), job({ id: "b", status: "queued" })];
    const snapshot = jobs.map((j) => j.id);
    findDuplicateJobs(jobs);
    expect(jobs.map((j) => j.id)).toEqual(snapshot);
  });
});
