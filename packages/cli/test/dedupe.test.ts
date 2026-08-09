import { type DedupePlan, planDedupe, type RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_DUPLICATES_MESSAGE, renderDedupePlan, renderDedupePlanJson } from "../src/dedupe.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${String(seq).padStart(4, "0")}`,
    project: "web",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/repo/web",
    status: "waiting_for_reset",
    resetAt: "2026-07-30T09:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function plan(jobs: RelayJob[]): DedupePlan {
  return planDedupe(jobs);
}

describe("renderDedupePlan", () => {
  it("shows the no-duplicates message for a clean queue", () => {
    expect(renderDedupePlan(plan([job()]))).toBe(NO_DUPLICATES_MESSAGE);
  });

  it("appends a scope note to the empty message when scoped", () => {
    const out = renderDedupePlan(plan([job()]), { scopeNote: "project=ghost" });
    expect(out).toContain(NO_DUPLICATES_MESSAGE);
    expect(out).toContain("project=ghost");
  });

  it("lists the shared command, keeper, and duplicates with cancel marks", () => {
    const out = renderDedupePlan(
      plan([job({ id: "keepme", resetAt: null, status: "queued" }), job({ id: "dropme" })]),
      { cancelledCount: 1 }
    );
    expect(out).toContain("claude -p continue");
    expect(out).toContain("in /repo/web");
    expect(out).toContain("keep keepme");
    expect(out).toContain("× dropme");
    expect(out).toContain("Cancelled 1 duplicate job(s) across 1 command(s).");
  });

  it("uses preview verbs and footer on a dry run", () => {
    const out = renderDedupePlan(plan([job({ id: "a" }), job({ id: "b" })]), { dryRun: true });
    expect(out).toContain("- ");
    expect(out).not.toContain("× ");
    expect(out).toContain("Would cancel 1 duplicate job(s) across 1 command(s) — no changes made.");
  });
});

describe("renderDedupePlanJson", () => {
  it("emits full ids, totals, and per-group keep/duplicate ids", () => {
    const p = plan([
      job({ id: "keep-1", resetAt: null, status: "queued" }),
      job({ id: "dup-1" }),
      job({ id: "dup-2" }),
    ]);
    const parsed = JSON.parse(
      renderDedupePlanJson(p, { storePath: "/tmp/jobs.json", dryRun: false, cancelledIds: ["dup-1", "dup-2"] })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.dryRun).toBe(false);
    expect(parsed.duplicateCount).toBe(2);
    expect(parsed.scannedCount).toBe(3);
    expect(parsed.cancelledIds).toEqual(["dup-1", "dup-2"]);
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0].keep).toBe("keep-1");
    expect(parsed.groups[0].duplicates.sort()).toEqual(["dup-1", "dup-2"]);
    expect(parsed.groups[0].command).toEqual(["claude", "-p", "continue"]);
  });

  it("reports an empty plan cleanly", () => {
    const parsed = JSON.parse(renderDedupePlanJson(plan([job()]), { storePath: "/tmp/jobs.json", dryRun: true }));
    expect(parsed.duplicateCount).toBe(0);
    expect(parsed.groups).toEqual([]);
    expect(parsed.cancelledIds).toEqual([]);
  });
});
