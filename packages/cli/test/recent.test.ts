import { buildRecentReport, type RecentReport, type RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_RECENT_MESSAGE, renderRecent, renderRecentJson } from "../src/recent.js";

const NOW = Date.parse("2026-07-30T10:00:00.000Z");

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
    status: "completed",
    resetAt: null,
    createdAt: at(-3 * 3_600_000),
    updatedAt: at(-60 * 60_000),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function report(jobs: RelayJob[], options: { limit?: number; withinMs?: number } = {}): RecentReport {
  return buildRecentReport(jobs, NOW, options);
}

describe("renderRecent", () => {
  it("shows the nothing-resolved message for an empty store", () => {
    expect(renderRecent(report([]))).toBe(NO_RECENT_MESSAGE);
  });

  it("appends the scope note and within window to the empty message", () => {
    const out = renderRecent(report([], { withinMs: 60 * 60_000 }), { scopeNote: "project=ghost" });
    expect(out).toContain(NO_RECENT_MESSAGE);
    expect(out).toContain("scope: project=ghost");
    expect(out).toContain("within 1h 0m");
  });

  it("renders one row per resolved job, newest first, with outcome and age", () => {
    const out = renderRecent(
      report([
        job({ id: "older000", project: "older-app", status: "failed", updatedAt: at(-4 * 3_600_000) }),
        job({ id: "newer000", project: "newer-app", status: "completed", updatedAt: at(-30 * 60_000) }),
      ])
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("PROJECT");
    expect(lines[0]).toContain("OUTCOME");
    expect(lines[0]).toContain("RESOLVED");
    expect(lines[0]).toContain("TOOK");
    expect(out.indexOf("newer-app")).toBeLessThan(out.indexOf("older-app"));
    expect(out).toContain("completed");
    expect(out).toContain("failed");
    expect(out).toContain("30m 0s ago");
  });

  it("shows a dash for TOOK when the lifecycle span is unknown", () => {
    const out = renderRecent(report([job({ createdAt: "not-a-date" })]));
    // header + row: the TOOK column should be a dash for this row
    const rowLine = out.split("\n").find((l) => l.includes("abcdef12"));
    expect(rowLine?.trimEnd().endsWith("-")).toBe(true);
  });

  it("footer reports totals, outcome tally, and hidden rows under a limit", () => {
    const jobs = [
      job({ id: "j1", status: "completed", updatedAt: at(-30 * 60_000) }),
      job({ id: "j2", status: "failed", updatedAt: at(-60 * 60_000) }),
      job({ id: "j3", status: "cancelled", updatedAt: at(-90 * 60_000) }),
    ];
    const out = renderRecent(report(jobs, { limit: 1 }));
    expect(out).toContain("3 resolved jobs");
    expect(out).toContain("1 completed · 1 failed · 1 cancelled");
    expect(out).toContain("2 more not shown");
  });

  it("does not emit ANSI escapes when color is off", () => {
    const out = renderRecent(report([job()]), { color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no escapes.
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("emits ANSI outcome coloring when color is on", () => {
    const out = renderRecent(report([job({ status: "completed" })]), { color: true });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting green code present.
    expect(out).toMatch(/\x1b\[32m/);
  });
});

describe("renderRecentJson", () => {
  it("emits the store path, report, and honest totals", () => {
    const r = report(
      [
        job({ id: "j1", status: "completed", updatedAt: at(-30 * 60_000) }),
        job({ id: "j2", status: "failed", updatedAt: at(-60 * 60_000) }),
      ],
      { limit: 1 }
    );
    const parsed = JSON.parse(
      renderRecentJson({ storePath: "/tmp/jobs.json", generatedAt: "2026-07-30T10:00:00.000Z", report: r })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.report.entries).toHaveLength(1);
    expect(parsed.report.entries[0].job.id).toBe("j1");
    expect(parsed.report.totalTerminal).toBe(2);
    expect(parsed.report.byOutcome).toEqual({ completed: 1, failed: 1, cancelled: 0 });
  });

  it("includes the scope when one is passed", () => {
    const parsed = JSON.parse(
      renderRecentJson({
        storePath: "/tmp/jobs.json",
        scope: { statuses: ["failed"] },
        report: report([]),
      })
    );
    expect(parsed.scope).toEqual({ statuses: ["failed"] });
  });
});
