import type { JobsDiff, RelayJob } from "@agentrelay/core";
import { diffJobs } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_DIFF_MESSAGE, renderDiff, renderDiffJson } from "../src/diff.js";

const NOW = Date.parse("2026-07-13T00:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "abcdef1234567890",
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

describe("renderDiff", () => {
  it("shows the no-diff message and a zeroed summary when identical", () => {
    const jobs = [job({ id: "a" })];
    const diff = diffJobs(
      jobs,
      jobs.map((j) => ({ ...j }))
    );
    const out = renderDiff(diff);
    expect(out).toContain("+0 added");
    expect(out).toContain("-0 removed");
    expect(out).toContain("~0 changed");
    expect(out).toContain("=1 unchanged");
    expect(out).toContain(NO_DIFF_MESSAGE);
  });

  it("lists added, removed, and changed jobs with sections", () => {
    const base = [
      job({ id: "gone-1", project: "svc", status: "queued" }),
      job({ id: "mut-1", status: "waiting_for_reset" }),
    ];
    const target = [
      job({ id: "mut-1", status: "completed", attempts: 2 }),
      job({ id: "new-1", project: "web", status: "queued" }),
    ];
    const diff = diffJobs(base, target);
    const out = renderDiff(diff);
    expect(out).toContain("added:");
    expect(out).toContain("+ new-1");
    expect(out).toContain("web");
    expect(out).toContain("removed:");
    expect(out).toContain("- gone-1");
    expect(out).toContain("changed:");
    expect(out).toContain("~ mut-1");
    expect(out).toContain("status: waiting_for_reset → completed");
    expect(out).toContain("attempts: 1 → 2");
    expect(out).not.toContain(NO_DIFF_MESSAGE);
  });

  it("renders null field values as ∅", () => {
    const base = [job({ id: "a", lastError: null })];
    const target = [job({ id: "a", lastError: "boom" })];
    const out = renderDiff(diffJobs(base, target));
    expect(out).toContain("lastError: ∅ → boom");
  });

  it("includes the snapshot path when provided", () => {
    const diff = diffJobs([], []);
    const out = renderDiff(diff, { from: "/tmp/jobs.json.backup-x" });
    expect(out).toContain("snapshot: /tmp/jobs.json.backup-x");
  });

  it("wraps values in ANSI codes only when color is enabled", () => {
    const base: RelayJob[] = [];
    const target = [job({ id: "a" })];
    const diff = diffJobs(base, target);
    expect(renderDiff(diff, { color: false })).not.toContain("\x1b[");
    expect(renderDiff(diff, { color: true })).toContain("\x1b[");
  });
});

describe("renderDiffJson", () => {
  it("emits from, generatedAt, and the diff", () => {
    const diff: JobsDiff = diffJobs([job({ id: "gone" })], [job({ id: "fresh" })]);
    const out = renderDiffJson(diff, "/tmp/snap", "2026-07-13T00:00:00.000Z");
    const parsed = JSON.parse(out);
    expect(parsed.from).toBe("/tmp/snap");
    expect(parsed.generatedAt).toBe("2026-07-13T00:00:00.000Z");
    expect(parsed.diff.added.map((j: RelayJob) => j.id)).toEqual(["fresh"]);
    expect(parsed.diff.removed.map((j: RelayJob) => j.id)).toEqual(["gone"]);
    expect(parsed.diff.unchanged).toBe(0);
  });
});
