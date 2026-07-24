import { describe, expect, it } from "vitest";
import { DIFFABLE_FIELDS, diffJobs, isEmptyDiff } from "./diff.js";
import type { RelayJob } from "./types.js";

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "job-1",
    project: "proj",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "queued",
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 0,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("diffJobs", () => {
  it("returns an all-empty diff for two empty snapshots", () => {
    const diff = diffJobs([], []);
    expect(diff).toEqual({ added: [], removed: [], changed: [], unchanged: 0 });
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("reports a job present only in after as added", () => {
    const a = job({ id: "a" });
    const diff = diffJobs([], [a]);
    expect(diff.added).toEqual([a]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it("reports a job present only in before as removed", () => {
    const a = job({ id: "a" });
    const diff = diffJobs([a], []);
    expect(diff.removed).toEqual([a]);
    expect(diff.added).toEqual([]);
  });

  it("counts an unchanged common job without listing it", () => {
    const a = job({ id: "a" });
    const diff = diffJobs([a], [{ ...a }]);
    expect(diff.unchanged).toBe(1);
    expect(diff.changed).toEqual([]);
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("reports a changed job with the differing tracked fields in order", () => {
    const before = job({ id: "a", status: "waiting_for_reset", attempts: 1 });
    const after = job({ id: "a", status: "completed", attempts: 2 });
    const diff = diffJobs([before], [after]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].id).toBe("a");
    expect(diff.changed[0].changes).toEqual([
      { field: "status", before: "waiting_for_reset", after: "completed" },
      { field: "attempts", before: 1, after: 2 },
    ]);
  });

  it("ignores changes to non-tracked fields (updatedAt/lastOutputTail)", () => {
    const before = job({ id: "a", updatedAt: "2026-07-13T00:00:00.000Z", lastOutputTail: null });
    const after = job({ id: "a", updatedAt: "2026-07-14T00:00:00.000Z", lastOutputTail: "some output" });
    const diff = diffJobs([before], [after]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toBe(1);
  });

  it("tracks resetAt null↔value and lastError transitions", () => {
    const before = job({ id: "a", resetAt: null, lastError: null });
    const after = job({ id: "a", resetAt: "2026-07-13T18:00:00.000Z", lastError: "boom" });
    const diff = diffJobs([before], [after]);
    expect(diff.changed[0].changes).toEqual([
      { field: "resetAt", before: null, after: "2026-07-13T18:00:00.000Z" },
      { field: "lastError", before: null, after: "boom" },
    ]);
  });

  it("tracks project and tool changes", () => {
    const before = job({ id: "a", project: "old", tool: "claude-code" });
    const after = job({ id: "a", project: "new", tool: "codex-cli" });
    const diff = diffJobs([before], [after]);
    expect(diff.changed[0].changes).toEqual([
      { field: "project", before: "old", after: "new" },
      { field: "tool", before: "claude-code", after: "codex-cli" },
    ]);
  });

  it("orders added/removed newest-first regardless of input order", () => {
    const older = job({ id: "older", createdAt: "2026-07-10T00:00:00.000Z" });
    const newer = job({ id: "newer", createdAt: "2026-07-20T00:00:00.000Z" });
    const diff = diffJobs([], [older, newer]);
    expect(diff.added.map((j) => j.id)).toEqual(["newer", "older"]);
  });

  it("breaks createdAt ties by id ascending", () => {
    const b = job({ id: "b", createdAt: "2026-07-10T00:00:00.000Z" });
    const a = job({ id: "a", createdAt: "2026-07-10T00:00:00.000Z" });
    const diff = diffJobs([], [b, a]);
    expect(diff.added.map((j) => j.id)).toEqual(["a", "b"]);
  });

  it("handles a mixed diff: add + remove + change + unchanged together", () => {
    const kept = job({ id: "kept" });
    const gone = job({ id: "gone" });
    const changedBefore = job({ id: "chg", status: "queued" });
    const changedAfter = job({ id: "chg", status: "resuming" });
    const fresh = job({ id: "fresh" });

    const diff = diffJobs([kept, gone, changedBefore], [{ ...kept }, changedAfter, fresh]);
    expect(diff.added.map((j) => j.id)).toEqual(["fresh"]);
    expect(diff.removed.map((j) => j.id)).toEqual(["gone"]);
    expect(diff.changed.map((c) => c.id)).toEqual(["chg"]);
    expect(diff.unchanged).toBe(1);
  });

  it("does not mutate its inputs", () => {
    const before = [job({ id: "b" }), job({ id: "a" })];
    const after = [job({ id: "c" })];
    const beforeCopy = before.map((j) => ({ ...j }));
    diffJobs(before, after);
    expect(before).toEqual(beforeCopy);
  });

  it("DIFFABLE_FIELDS lists the tracked lifecycle fields", () => {
    expect(DIFFABLE_FIELDS).toEqual(["status", "resetAt", "attempts", "lastError", "project", "tool"]);
  });
});
