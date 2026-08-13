import { describe, expect, it } from "vitest";
import { DIFF_TRACKED_FIELDS, diffJobs, isEmptyDiff } from "./diff.js";
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
    status: "waiting_for_reset",
    resetAt: "2026-08-13T09:00:00.000Z",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("diffJobs", () => {
  it("returns an all-empty diff for two identical (empty) snapshots", () => {
    const diff = diffJobs([], []);
    expect(diff).toEqual({ added: [], removed: [], changed: [], unchanged: 0 });
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("detects added jobs (present only in after)", () => {
    const shared = job({ id: "keep" });
    const diff = diffJobs([shared], [shared, job({ id: "new" })]);
    expect(diff.added.map((j) => j.id)).toEqual(["new"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toBe(1);
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it("detects removed jobs (present only in before)", () => {
    const shared = job({ id: "keep" });
    const diff = diffJobs([shared, job({ id: "gone" })], [shared]);
    expect(diff.removed.map((j) => j.id)).toEqual(["gone"]);
    expect(diff.added).toEqual([]);
    expect(diff.unchanged).toBe(1);
  });

  it("reports changed tracked fields with before/after values", () => {
    const before = job({ id: "x", status: "waiting_for_reset", attempts: 1, lastError: null });
    const after = job({ id: "x", status: "completed", attempts: 2, lastError: "boom" });
    const diff = diffJobs([before], [after]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].id).toBe("x");
    expect(diff.changed[0].fields).toEqual([
      { field: "status", before: "waiting_for_reset", after: "completed" },
      { field: "attempts", before: 1, after: 2 },
      { field: "lastError", before: null, after: "boom" },
    ]);
    expect(diff.unchanged).toBe(0);
  });

  it("counts jobs present in both with no tracked change as unchanged", () => {
    // updatedAt differs but is deliberately not tracked -> still unchanged.
    const before = job({ id: "y", updatedAt: "2026-08-13T00:00:00.000Z" });
    const after = job({ id: "y", updatedAt: "2026-08-13T05:00:00.000Z" });
    const diff = diffJobs([before], [after]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toBe(1);
  });

  it("detects a changed command (joined) and project relabel", () => {
    const before = job({ id: "z", command: ["claude", "-p", "a"], project: "old" });
    const after = job({ id: "z", command: ["claude", "-p", "b"], project: "new" });
    const diff = diffJobs([before], [after]);
    const fields = diff.changed[0].fields.map((f) => f.field);
    expect(fields).toContain("command");
    expect(fields).toContain("project");
  });

  it("sorts each group newest-first (createdAt desc, id asc tiebreak)", () => {
    const older = job({ id: "b", createdAt: "2026-08-13T01:00:00.000Z" });
    const newer = job({ id: "a", createdAt: "2026-08-13T02:00:00.000Z" });
    const diff = diffJobs([], [older, newer]);
    expect(diff.added.map((j) => j.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input arrays", () => {
    const before = [job({ id: "1" }), job({ id: "2" })];
    const after = [job({ id: "2" }), job({ id: "3" })];
    const beforeCopy = [...before];
    const afterCopy = [...after];
    diffJobs(before, after);
    expect(before).toEqual(beforeCopy);
    expect(after).toEqual(afterCopy);
  });

  it("exposes the tracked field list without noisy fields", () => {
    expect(DIFF_TRACKED_FIELDS).toContain("status");
    expect(DIFF_TRACKED_FIELDS).toContain("attempts");
    expect(DIFF_TRACKED_FIELDS).toContain("resetAt");
    expect(DIFF_TRACKED_FIELDS).not.toContain("updatedAt");
    expect(DIFF_TRACKED_FIELDS).not.toContain("lastOutputTail");
  });
});
