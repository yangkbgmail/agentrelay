import { describe, expect, it } from "vitest";
import { DIFF_FIELDS, diffJobStores, isStoreDiffEmpty } from "./diff.js";
import type { RelayJob } from "./types.js";

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "a",
    project: "proj",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "queued",
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("diffJobStores", () => {
  it("reports an empty delta for two empty stores", () => {
    const diff = diffJobStores([], []);
    expect(diff).toEqual({
      added: [],
      removed: [],
      changed: [],
      unchangedCount: 0,
      beforeCount: 0,
      afterCount: 0,
    });
    expect(isStoreDiffEmpty(diff)).toBe(true);
  });

  it("detects added jobs (in after, not before)", () => {
    const added = job({ id: "new" });
    const diff = diffJobStores([], [added]);
    expect(diff.added).toEqual([added]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.afterCount).toBe(1);
    expect(diff.beforeCount).toBe(0);
    expect(isStoreDiffEmpty(diff)).toBe(false);
  });

  it("detects removed jobs (in before, not after)", () => {
    const gone = job({ id: "old" });
    const diff = diffJobStores([gone], []);
    expect(diff.removed).toEqual([gone]);
    expect(diff.added).toEqual([]);
    expect(diff.unchangedCount).toBe(0);
  });

  it("counts identical jobs as unchanged, not changed", () => {
    const before = job({ id: "same" });
    const after = job({ id: "same" });
    const diff = diffJobStores([before], [after]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
    expect(isStoreDiffEmpty(diff)).toBe(true);
  });

  it("reports a changed job with the fields that differ", () => {
    const before = job({ id: "x", status: "waiting_for_reset", attempts: 1, resetAt: "2026-07-13T17:00:00.000Z" });
    const after = job({ id: "x", status: "completed", attempts: 2, resetAt: null });
    const diff = diffJobStores([before], [after]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].id).toBe("x");
    expect(diff.changed[0].project).toBe("proj");
    expect(diff.changed[0].changes).toEqual([
      { field: "status", before: "waiting_for_reset", after: "completed" },
      { field: "resetAt", before: "2026-07-13T17:00:00.000Z", after: "(none)" },
      { field: "attempts", before: "1", after: "2" },
    ]);
  });

  it("renders null lastError as (none) on both sides", () => {
    const before = job({ id: "e", lastError: null });
    const after = job({ id: "e", lastError: "boom" });
    const diff = diffJobStores([before], [after]);
    expect(diff.changed[0].changes).toEqual([{ field: "lastError", before: "(none)", after: "boom" }]);
  });

  it("ignores non-tracked fields (updatedAt/command) as unchanged", () => {
    const before = job({ id: "u", updatedAt: "2026-07-13T00:00:00.000Z", command: ["claude", "-p", "one"] });
    const after = job({ id: "u", updatedAt: "2026-07-14T00:00:00.000Z", command: ["claude", "-p", "two"] });
    const diff = diffJobStores([before], [after]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });

  it("classifies a mixed store in one pass", () => {
    const before = [
      job({ id: "keep", status: "completed" }),
      job({ id: "move", status: "queued" }),
      job({ id: "drop", status: "queued" }),
    ];
    const after = [
      job({ id: "keep", status: "completed" }),
      job({ id: "move", status: "completed" }),
      job({ id: "fresh", status: "queued" }),
    ];
    const diff = diffJobStores(before, after);
    expect(diff.added.map((j) => j.id)).toEqual(["fresh"]);
    expect(diff.removed.map((j) => j.id)).toEqual(["drop"]);
    expect(diff.changed.map((c) => c.id)).toEqual(["move"]);
    expect(diff.unchangedCount).toBe(1);
    expect(diff.beforeCount).toBe(3);
    expect(diff.afterCount).toBe(3);
  });

  it("follows after-order for changed and source-order for added/removed", () => {
    const before = [job({ id: "r1" }), job({ id: "r2" })];
    const after = [job({ id: "a1" }), job({ id: "a2" })];
    const diff = diffJobStores(before, after);
    expect(diff.added.map((j) => j.id)).toEqual(["a1", "a2"]);
    expect(diff.removed.map((j) => j.id)).toEqual(["r1", "r2"]);
  });

  it("exposes the tracked field set", () => {
    expect(DIFF_FIELDS).toEqual(["status", "resetAt", "attempts", "lastError"]);
  });
});
