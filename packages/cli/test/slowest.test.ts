import { buildSlowestReport, type RelayJob, type SlowestReport } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_RESOLVED_MESSAGE, renderSlowest, renderSlowestJson } from "../src/slowest.js";

const HOUR = 3_600_000;

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "abcdef1234567890",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T02:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function report(jobs: RelayJob[], options: { limit?: number } = {}): SlowestReport {
  return buildSlowestReport(jobs, options);
}

describe("renderSlowest", () => {
  it("shows the no-resolved message when nothing has resolved", () => {
    expect(renderSlowest(report([]))).toBe(NO_RESOLVED_MESSAGE);
  });

  it("appends the scope note to the empty message when scoped", () => {
    const out = renderSlowest(report([]), { scopeNote: "tool=codex-cli" });
    expect(out).toContain(NO_RESOLVED_MESSAGE);
    expect(out).toContain("scope: tool=codex-cli");
  });

  it("renders one row per resolved job, slowest first", () => {
    const out = renderSlowest(
      report([
        job({ id: "short0000", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T00:30:00.000Z" }),
        job({ id: "long00000", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T05:00:00.000Z" }),
      ])
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("RESOLVED IN");
    // slowest (5h) row comes before the 30m row
    expect(lines[1]).toContain("long0000");
    expect(lines[1]).toContain("5h 0m");
    expect(lines[2]).toContain("short000");
    expect(lines[2]).toContain("30m 0s");
  });

  it("footer reports totals and hidden count under a limit", () => {
    const jobs = [
      job({ id: "j1", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T04:00:00.000Z" }),
      job({ id: "j2", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T03:00:00.000Z" }),
      job({ id: "j3", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T02:00:00.000Z" }),
    ];
    const out = renderSlowest(report(jobs, { limit: 2 }));
    expect(out).toContain("3 resolved jobs");
    expect(out).toContain("slowest 4h 0m");
    expect(out).toContain("1 more not shown");
  });

  it("renderSlowestJson carries the store path, scope, and full report", () => {
    const r = report([job({ id: "j1", updatedAt: "2026-07-30T03:00:00.000Z" })]);
    const parsed = JSON.parse(
      renderSlowestJson({
        storePath: "/x/jobs.json",
        generatedAt: "2026-07-30T10:00:00.000Z",
        scope: { tools: ["claude-code"] },
        report: r,
      })
    );
    expect(parsed.storePath).toBe("/x/jobs.json");
    expect(parsed.scope).toEqual({ tools: ["claude-code"] });
    expect(parsed.report.totalResolved).toBe(1);
    expect(parsed.report.maxResolutionMs).toBe(3 * HOUR);
  });
});
