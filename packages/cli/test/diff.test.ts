import type { RelayJob, StoreDiff } from "@agentrelay/core";
import { diffJobs } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_DIFF_MESSAGE, renderStoreDiff, renderStoreDiffJson } from "../src/diff.js";

function job(overrides: Partial<RelayJob>): RelayJob {
  return {
    id: "aaaaaaaa1111",
    project: "proj",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "queued",
    resetAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:05:00.000Z",
    attempts: 0,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function diffOf(before: RelayJob[], after: RelayJob[]): StoreDiff {
  return diffJobs(before, after);
}

describe("renderStoreDiff", () => {
  it("shows the no-diff message when nothing changed", () => {
    const j = job({ id: "same" });
    const out = renderStoreDiff(diffOf([j], [{ ...j }]));
    expect(out).toContain(NO_DIFF_MESSAGE);
    expect(out).toContain("+0 added");
    expect(out).toContain("=1 unchanged");
  });

  it("echoes the compared snapshot path when given", () => {
    const out = renderStoreDiff(diffOf([], []), { from: "/store/jobs.json.backup-x" });
    expect(out).toContain("against: /store/jobs.json.backup-x");
  });

  it("renders an added job with a + line", () => {
    const out = renderStoreDiff(diffOf([], [job({ id: "newjob00", project: "web", status: "queued" })]));
    expect(out).toContain("+ newjob00 web (queued)");
    expect(out).toContain("+1 added");
  });

  it("renders a removed job with a - line", () => {
    const out = renderStoreDiff(diffOf([job({ id: "gonejob0", status: "completed" })], []));
    expect(out).toContain("- gonejob0 proj (completed)");
    expect(out).toContain("-1 removed");
  });

  it("renders a changed job with field transitions", () => {
    const before = job({ id: "chg00000", status: "waiting_for_reset", attempts: 1 });
    const after = job({ id: "chg00000", status: "completed", attempts: 2 });
    const out = renderStoreDiff(diffOf([before], [after]));
    expect(out).toContain("~ chg00000 proj");
    expect(out).toContain("status: waiting_for_reset → completed");
    expect(out).toContain("attempts: 1 → 2");
    expect(out).toContain("~1 changed");
  });

  it("renders null field values as 'none'", () => {
    const before = job({ id: "n0000000", resetAt: null });
    const after = job({ id: "n0000000", resetAt: "2026-07-01T18:00:00.000Z" });
    const out = renderStoreDiff(diffOf([before], [after]));
    expect(out).toContain("resetAt: none → 2026-07-01T18:00:00.000Z");
  });

  it("does not emit ANSI codes when color is off", () => {
    const out = renderStoreDiff(diffOf([], [job({ id: "x" })]), { color: false });
    expect(out).not.toContain("\x1b[");
  });

  it("emits ANSI codes when color is on", () => {
    const out = renderStoreDiff(diffOf([], [job({ id: "x" })]), { color: true });
    expect(out).toContain("\x1b[");
  });
});

describe("renderStoreDiffJson", () => {
  it("emits counts, the from path, and full shapes", () => {
    const before = job({ id: "gone" });
    const after = job({ id: "fresh" });
    const parsed = JSON.parse(renderStoreDiffJson(diffOf([before], [after]), { from: "/snap" }));
    expect(parsed.from).toBe("/snap");
    expect(parsed.counts).toEqual({ added: 1, removed: 1, changed: 0, unchanged: 0 });
    expect(parsed.added[0].id).toBe("fresh");
    expect(parsed.removed[0].id).toBe("gone");
  });

  it("defaults from to null when omitted", () => {
    const parsed = JSON.parse(renderStoreDiffJson(diffOf([], [])));
    expect(parsed.from).toBeNull();
  });
});
