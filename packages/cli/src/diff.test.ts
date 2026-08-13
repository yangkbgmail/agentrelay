import type { JobDiff, RelayJob } from "@agentrelay/core";
import { diffJobs } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_DIFF_MESSAGE, renderDiff, renderDiffJson } from "./diff.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `abcd${seq}efghijkl`,
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

const LABELS = { before: "snapshot-A", after: "current store" };

function emptyDiff(overrides: Partial<JobDiff> = {}): JobDiff {
  return { added: [], removed: [], changed: [], unchanged: 0, ...overrides };
}

describe("renderDiff", () => {
  it("shows the no-diff message (with unchanged count) when snapshots match", () => {
    const out = renderDiff(emptyDiff({ unchanged: 3 }), LABELS);
    expect(out).toContain(NO_DIFF_MESSAGE);
    expect(out).toContain("3 unchanged");
    // Header names both sides.
    expect(out).toContain("snapshot-A");
    expect(out).toContain("current store");
  });

  it("lists added and removed jobs under labelled sections", () => {
    const added = job({ id: "new00000aaaa", project: "web", status: "queued" });
    const removed = job({ id: "old00000bbbb", project: "api", status: "completed" });
    const out = renderDiff(emptyDiff({ added: [added], removed: [removed], unchanged: 5 }), LABELS);
    expect(out).toContain("+ added (1)");
    expect(out).toContain("new00000"); // short id
    expect(out).toContain("web");
    expect(out).toContain("- removed (1)");
    expect(out).toContain("old00000");
    expect(out).toContain("5 unchanged.");
  });

  it("renders per-field before → after lines for changed jobs", () => {
    const before = job({ id: "chng0000cccc", status: "waiting_for_reset", attempts: 1 });
    const after = job({ id: "chng0000cccc", status: "completed", attempts: 2 });
    const diff = diffJobs([before], [after]);
    const out = renderDiff(diff, LABELS);
    expect(out).toContain("~ changed (1)");
    expect(out).toContain("chng0000");
    expect(out).toContain("status: waiting_for_reset");
    expect(out).toContain("completed");
    expect(out).toContain("attempts: 1");
    expect(out).toContain("2");
  });

  it("shows ∅ for a null value (a cleared error)", () => {
    const before = job({ id: "err00000dddd", lastError: "boom" });
    const after = job({ id: "err00000dddd", lastError: null });
    const out = renderDiff(diffJobs([before], [after]), LABELS);
    expect(out).toContain("lastError: boom");
    expect(out).toContain("∅");
  });

  it("emits no ANSI escapes when color is off, but does when on", () => {
    const diff = emptyDiff({ added: [job({ id: "x0000000yyyy" })] });
    expect(renderDiff(diff, LABELS, { color: false })).not.toContain("\x1b[");
    expect(renderDiff(diff, LABELS, { color: true })).toContain("\x1b[");
  });
});

describe("renderDiffJson", () => {
  it("carries the labels, a generatedAt stamp, and the full diff", () => {
    const diff = emptyDiff({ unchanged: 2 });
    const parsed = JSON.parse(renderDiffJson(diff, LABELS, "2026-08-13T12:00:00.000Z"));
    expect(parsed.before).toBe("snapshot-A");
    expect(parsed.after).toBe("current store");
    expect(parsed.generatedAt).toBe("2026-08-13T12:00:00.000Z");
    expect(parsed.diff.unchanged).toBe(2);
  });
});
