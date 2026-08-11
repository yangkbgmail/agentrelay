import type { RelayJob } from "@agentrelay/core";
import { buildStaleReport } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_STALE_MESSAGE, renderStale, renderStaleJson } from "./stale.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `abcdef${seq}0-1111-2222-3333-444444444444`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "resuming",
    resetAt: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T08:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-30T10:00:00.000Z");

describe("renderStale", () => {
  it("shows the all-clear message when nothing is wedged", () => {
    const report = buildStaleReport([], NOW);
    expect(renderStale(report)).toBe(NO_STALE_MESSAGE);
  });

  it("appends the grace hint to the all-clear message when a grace is set", () => {
    const report = buildStaleReport([], NOW, { graceMs: 15 * 60 * 1000 });
    expect(renderStale(report)).toContain(NO_STALE_MESSAGE);
    expect(renderStale(report)).toContain("grace 15m");
  });

  it("renders a row per wedged job with its status and stale span", () => {
    const report = buildStaleReport(
      [
        job({ id: "orphan01-aaaa", status: "resuming", updatedAt: "2026-07-30T08:00:00.000Z" }),
        job({ id: "unparked1-bbbb", status: "queued", updatedAt: "2026-07-30T09:00:00.000Z" }),
      ],
      NOW
    );
    const out = renderStale(report);
    expect(out).toContain("STATUS");
    expect(out).toContain("STALE FOR");
    expect(out).toContain("resuming");
    expect(out).toContain("queued");
    // Most-stale first: the 2h-old resuming row precedes the 1h-old queued row.
    expect(out.indexOf("resuming")).toBeLessThan(out.indexOf("queued"));
    // Footer: totals + per-status breakdown + recovery advice.
    expect(out).toContain("2 jobs stale");
    expect(out).toContain("1 queued, 1 resuming");
    expect(out).toContain("agentrelay cancel");
  });

  it("uses the singular 'job' in the footer for a single wedged job", () => {
    const report = buildStaleReport([job({ status: "resuming" })], NOW);
    expect(renderStale(report)).toContain("1 job stale");
  });

  it("notes hidden rows when a limit trims the table", () => {
    const report = buildStaleReport(
      [
        job({ id: "j1", updatedAt: "2026-07-30T06:00:00.000Z" }),
        job({ id: "j2", updatedAt: "2026-07-30T07:00:00.000Z" }),
        job({ id: "j3", updatedAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW,
      { limit: 1 }
    );
    const out = renderStale(report);
    expect(out).toContain("3 jobs stale");
    expect(out).toContain("2 more not shown");
  });

  it("emits a scope note when one is provided", () => {
    const report = buildStaleReport([job({ status: "resuming" })], NOW);
    expect(renderStale(report, { scopeNote: "project=alpha" })).toContain("[scope: project=alpha]");
    expect(renderStale(buildStaleReport([], NOW), { scopeNote: "project=alpha" })).toContain("[scope: project=alpha]");
  });
});

describe("renderStaleJson", () => {
  it("wraps the report with provenance and echoes the full report", () => {
    const report = buildStaleReport([job({ id: "j1", status: "resuming" })], NOW, { graceMs: 1000 });
    const parsed = JSON.parse(
      renderStaleJson({
        storePath: "/home/u/.agentrelay/jobs.json",
        generatedAt: "2026-07-30T10:00:00.000Z",
        scope: { project: ["alpha"] },
        report,
      })
    );
    expect(parsed.storePath).toBe("/home/u/.agentrelay/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.scope).toEqual({ project: ["alpha"] });
    expect(parsed.report.totalStale).toBe(1);
    expect(parsed.report.graceMs).toBe(1000);
    expect(parsed.report.byStatus).toEqual({ resuming: 1 });
  });
});
