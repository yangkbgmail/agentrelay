import { diffJobStores, type RelayJob, type StoreDiff } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { renderDiff, renderDiffJson } from "../src/diff.js";

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "aaaaaaaa-1111",
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

describe("renderDiff", () => {
  it("prints a 'No differences' line when the store matches the snapshot", () => {
    const same = job({ id: "same" });
    const out = renderDiff(diffJobStores([same], [same]));
    expect(out).toContain("No differences");
  });

  it("lists added, removed, and changed sections with counts", () => {
    const before = [job({ id: "gone1234", status: "queued" }), job({ id: "move1234", status: "waiting_for_reset" })];
    const after = [job({ id: "move1234", status: "completed" }), job({ id: "new12345", status: "queued" })];
    const out = renderDiff(diffJobStores(before, after));
    expect(out).toContain("+ Added (1)");
    expect(out).toContain("new12345");
    expect(out).toContain("- Removed (1)");
    expect(out).toContain("gone1234");
    expect(out).toContain("~ Changed (1)");
    expect(out).toContain("move1234");
    // the changed field line shows before → after
    expect(out).toContain("status: waiting_for_reset → completed");
  });

  it("shows short (8-char) job ids, not full ids", () => {
    const out = renderDiff(diffJobStores([], [job({ id: "aaaaaaaa-bbbb-cccc" })]));
    expect(out).toContain("aaaaaaaa");
    expect(out).not.toContain("aaaaaaaa-bbbb");
  });

  it("includes a summary line with all four counts", () => {
    const before = [job({ id: "d" }), job({ id: "k" })];
    const after = [job({ id: "k" }), job({ id: "n" })];
    const out = renderDiff(diffJobStores(before, after));
    expect(out).toContain("2 → 2 job(s)");
    expect(out).toContain("+1 added");
    expect(out).toContain("-1 removed");
    expect(out).toContain("~0 changed");
    expect(out).toContain("1 unchanged");
  });

  it("shows the snapshot source in the header when given", () => {
    const out = renderDiff(diffJobStores([], []), { from: "/x/jobs.json.backup-2026" });
    expect(out).toContain("/x/jobs.json.backup-2026");
    expect(out).toContain("current store");
  });

  it("emits no ANSI codes when color is off", () => {
    const before = [job({ id: "gone" })];
    const after = [job({ id: "new" })];
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderDiff(diffJobStores(before, after), { color: false })).not.toMatch(/\x1b\[/);
  });

  it("emits ANSI codes when color is on", () => {
    const before = [job({ id: "gone" })];
    const after = [job({ id: "new" })];
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI escapes are present.
    expect(renderDiff(diffJobStores(before, after), { color: true })).toMatch(/\x1b\[/);
  });
});

describe("renderDiffJson", () => {
  it("produces valid JSON with generatedAt, from, and the diff shape", () => {
    const diff: StoreDiff = diffJobStores([job({ id: "old" })], [job({ id: "new" })]);
    const parsed = JSON.parse(renderDiffJson(diff, { from: "/x/snap", generatedAt: "2026-07-27T00:00:00.000Z" }));
    expect(parsed.generatedAt).toBe("2026-07-27T00:00:00.000Z");
    expect(parsed.from).toBe("/x/snap");
    expect(parsed.added.map((j: RelayJob) => j.id)).toEqual(["new"]);
    expect(parsed.removed.map((j: RelayJob) => j.id)).toEqual(["old"]);
    expect(parsed.beforeCount).toBe(1);
    expect(parsed.afterCount).toBe(1);
  });

  it("defaults from to null when no snapshot source is given", () => {
    const parsed = JSON.parse(renderDiffJson(diffJobStores([], []), { generatedAt: "2026-07-27T00:00:00.000Z" }));
    expect(parsed.from).toBeNull();
  });
});
