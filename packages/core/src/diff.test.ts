import { describe, expect, it } from "vitest";
import { DIFF_TRACKED_FIELDS, diffJobs, isEmptyDiff } from "./diff.js";
import type { RelayJob } from "./types.js";

const NOW = Date.parse("2026-07-13T00:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "job-a",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "waiting_for_reset",
    resetAt: at(90 * 60_000),
    createdAt: at(0),
    updatedAt: at(0),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("diffJobs", () => {
  it("reports an empty diff for identical sets", () => {
    const jobs = [job({ id: "a" }), job({ id: "b" })];
    const diff = diffJobs(
      jobs,
      jobs.map((j) => ({ ...j }))
    );
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toBe(2);
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("detects added jobs (present in target, not base)", () => {
    const base = [job({ id: "a" })];
    const target = [job({ id: "a" }), job({ id: "b" })];
    const diff = diffJobs(base, target);
    expect(diff.added.map((j) => j.id)).toEqual(["b"]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toBe(1);
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it("detects removed jobs (present in base, not target)", () => {
    const base = [job({ id: "a" }), job({ id: "b" })];
    const target = [job({ id: "a" })];
    const diff = diffJobs(base, target);
    expect(diff.removed.map((j) => j.id)).toEqual(["b"]);
    expect(diff.added).toEqual([]);
    expect(diff.unchanged).toBe(1);
  });

  it("detects changed tracked fields and lists them in DIFF_TRACKED_FIELDS order", () => {
    const base = [job({ id: "a", status: "waiting_for_reset", attempts: 1, lastError: null })];
    const target = [job({ id: "a", status: "completed", attempts: 2, lastError: "boom" })];
    const diff = diffJobs(base, target);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toBe(0);
    expect(diff.changed).toHaveLength(1);
    const change = diff.changed[0];
    expect(change.id).toBe("a");
    expect(change.changes.map((c) => c.field)).toEqual(["status", "attempts", "lastError"]);
    expect(change.changes[0]).toEqual({ field: "status", before: "waiting_for_reset", after: "completed" });
    expect(change.changes[1]).toEqual({ field: "attempts", before: 1, after: 2 });
    expect(change.changes[2]).toEqual({ field: "lastError", before: null, after: "boom" });
  });

  it("does not flag changes in untracked fields (project/cwd/command)", () => {
    const base = [job({ id: "a", project: "old", cwd: "/old", command: ["a"] })];
    const target = [job({ id: "a", project: "new", cwd: "/new", command: ["b"] })];
    const diff = diffJobs(base, target);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toBe(1);
  });

  it("treats resetAt null↔value as a change", () => {
    const base = [job({ id: "a", resetAt: null })];
    const target = [job({ id: "a", resetAt: at(60_000) })];
    const diff = diffJobs(base, target);
    expect(diff.changed[0].changes).toEqual([{ field: "resetAt", before: null, after: at(60_000) }]);
  });

  it("handles a mix of added, removed, changed, and unchanged", () => {
    const base = [
      job({ id: "keep", status: "completed" }),
      job({ id: "mutate", status: "waiting_for_reset" }),
      job({ id: "gone", status: "queued" }),
    ];
    const target = [
      job({ id: "keep", status: "completed" }),
      job({ id: "mutate", status: "completed" }),
      job({ id: "fresh", status: "queued" }),
    ];
    const diff = diffJobs(base, target);
    expect(diff.added.map((j) => j.id)).toEqual(["fresh"]);
    expect(diff.removed.map((j) => j.id)).toEqual(["gone"]);
    expect(diff.changed.map((c) => c.id)).toEqual(["mutate"]);
    expect(diff.unchanged).toBe(1);
  });

  it("orders added/removed newest-first by createdAt (id tiebreak)", () => {
    const base: RelayJob[] = [];
    const target = [
      job({ id: "old", createdAt: at(0) }),
      job({ id: "new", createdAt: at(10_000) }),
      job({ id: "mid", createdAt: at(5_000) }),
    ];
    const diff = diffJobs(base, target);
    expect(diff.added.map((j) => j.id)).toEqual(["new", "mid", "old"]);
  });

  it("respects a narrowed tracked-field set", () => {
    const base = [job({ id: "a", status: "queued", attempts: 1 })];
    const target = [job({ id: "a", status: "completed", attempts: 5 })];
    const diff = diffJobs(base, target, ["attempts"]);
    expect(diff.changed[0].changes.map((c) => c.field)).toEqual(["attempts"]);
  });

  it("last occurrence wins on duplicate ids (store load semantics)", () => {
    const base = [job({ id: "a", status: "queued" }), job({ id: "a", status: "completed" })];
    const target = [job({ id: "a", status: "completed" })];
    const diff = diffJobs(base, target);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toBe(1);
  });

  it("DIFF_TRACKED_FIELDS covers the mutable lifecycle fields", () => {
    expect(DIFF_TRACKED_FIELDS).toContain("status");
    expect(DIFF_TRACKED_FIELDS).toContain("attempts");
    expect(DIFF_TRACKED_FIELDS).not.toContain("id");
    expect(DIFF_TRACKED_FIELDS).not.toContain("createdAt");
  });
});
