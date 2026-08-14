import type { RelayJob } from "@agentrelay/core";
import { findDuplicateJobs } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  NO_DUPLICATES_MESSAGE,
  NO_JOBS_MESSAGE,
  NO_SCOPE_MATCH_MESSAGE,
  renderDedup,
  renderDedupJson,
} from "../src/dedup.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `abcdef${seq}0000`,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "waiting_for_reset",
    resetAt: "2026-07-12T18:00:00.000Z",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-12T12:00:00.000Z");

describe("renderDedup", () => {
  it("shows the onboarding message for an empty store", () => {
    const out = renderDedup(findDuplicateJobs([]), { hasJobs: false });
    expect(out).toBe(NO_JOBS_MESSAGE);
  });

  it("shows the no-match message for an empty scoped subset", () => {
    const out = renderDedup(findDuplicateJobs([]), { hasJobs: false, scopeNote: "project=web" });
    expect(out).toContain("scope: project=web");
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
  });

  it("shows the healthy message when jobs exist but none duplicate", () => {
    const out = renderDedup(findDuplicateJobs([job({ status: "queued" })]), { hasJobs: true });
    expect(out).toContain(NO_DUPLICATES_MESSAGE);
  });

  it("renders a cluster with counts, command, cwd, and job ids", () => {
    const report = findDuplicateJobs([
      job({ id: "aaaaaaaa1111", status: "queued", createdAt: "2026-07-12T00:00:00.000Z" }),
      job({ id: "bbbbbbbb2222", status: "queued", createdAt: "2026-07-12T01:00:00.000Z" }),
    ]);
    const out = renderDedup(report, { now: NOW, hasJobs: true });
    expect(out).toContain("1 duplicate cluster");
    expect(out).toContain("1 redundant resume(s)");
    expect(out).toContain("2×");
    expect(out).toContain("claude -p continue");
    expect(out).toContain("cwd: /tmp/demo");
    // short ids, oldest marked as keep
    expect(out).toContain("aaaaaaaa");
    expect(out).toContain("bbbbbbbb");
    expect(out).toContain("(keep)");
  });

  it("shows the next reset with a live countdown", () => {
    const report = findDuplicateJobs([
      job({ id: "a", status: "waiting_for_reset", resetAt: "2026-07-12T18:00:00.000Z" }),
      job({ id: "b", status: "waiting_for_reset", resetAt: "2026-07-12T18:00:00.000Z" }),
    ]);
    const out = renderDedup(report, { now: NOW, hasJobs: true });
    expect(out).toContain("next reset: 2026-07-12T18:00:00.000Z");
    expect(out).toContain("(in 6h 0m)");
  });

  it("trims to --limit and reports the hidden clusters", () => {
    const report = findDuplicateJobs([
      job({ id: "x1", command: ["c", "x"], cwd: "/x", status: "queued" }),
      job({ id: "x2", command: ["c", "x"], cwd: "/x", status: "queued" }),
      job({ id: "y1", command: ["c", "y"], cwd: "/y", status: "queued" }),
      job({ id: "y2", command: ["c", "y"], cwd: "/y", status: "queued" }),
    ]);
    const out = renderDedup(report, { now: NOW, hasJobs: true, limit: 1 });
    expect(out).toContain("2 duplicate clusters");
    expect(out).toContain("1 more cluster(s) not shown");
  });

  it("echoes an active scope note once at the top", () => {
    const report = findDuplicateJobs([job({ status: "queued" }), job({ status: "queued" })]);
    const out = renderDedup(report, { now: NOW, hasJobs: true, scopeNote: "tool=claude-code" });
    expect(out).toContain("scope: tool=claude-code");
  });
});

describe("renderDedupJson", () => {
  it("wraps the report in a stable envelope", () => {
    const report = findDuplicateJobs([job({ status: "queued" }), job({ status: "queued" })]);
    const json = renderDedupJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-12T12:00:00.000Z",
      report,
    });
    const parsed = JSON.parse(json);
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-12T12:00:00.000Z");
    expect(parsed.scope).toBeUndefined();
    expect(parsed.report.groupCount).toBe(1);
    expect(parsed.report.redundantJobs).toBe(1);
    expect(parsed.report.groups[0].count).toBe(2);
  });

  it("includes the scope when one is active", () => {
    const json = renderDedupJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-12T12:00:00.000Z",
      scope: { tools: ["claude-code"] },
      report: findDuplicateJobs([]),
    });
    expect(JSON.parse(json).scope).toEqual({ tools: ["claude-code"] });
  });
});
