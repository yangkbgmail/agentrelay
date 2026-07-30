import { buildOverdueReport, type OverdueReport, type RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_OVERDUE_MESSAGE, renderOverdue, renderOverdueJson } from "../src/overdue.js";

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
    status: "waiting_for_reset",
    resetAt: at(-90 * 60_000),
    createdAt: at(-5 * 3_600_000),
    updatedAt: at(-5 * 3_600_000),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function report(jobs: RelayJob[], options?: { limit?: number; minOverdueMs?: number }): OverdueReport {
  return buildOverdueReport(jobs, NOW, options);
}

describe("renderOverdue", () => {
  it("shows the healthy message when nothing is overdue", () => {
    expect(renderOverdue(report([]), { now: NOW })).toBe(NO_OVERDUE_MESSAGE);
  });

  it("appends the scope note to the healthy message when scoped", () => {
    const out = renderOverdue(report([]), { now: NOW, scopeNote: "project=ghost" });
    expect(out).toContain(NO_OVERDUE_MESSAGE);
    expect(out).toContain("scope: project=ghost");
  });

  it("renders one row per overdue job, longest-stuck first, with positions", () => {
    const out = renderOverdue(
      report([
        job({ id: "slight00", project: "slight-app", resetAt: at(-30 * 60_000) }),
        job({ id: "verylate", project: "very-app", resetAt: at(-5 * 3_600_000) }),
      ]),
      { now: NOW }
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("OVERDUE BY");
    // most overdue (very-app) appears before the slightly-late one.
    expect(out.indexOf("very-app")).toBeLessThan(out.indexOf("slight-app"));
    expect(out).toContain("1  ");
    expect(out).toContain("2  ");
  });

  it("formats how long each job is overdue with the shared duration format", () => {
    const out = renderOverdue(report([job({ resetAt: at(-90 * 60_000) })]), { now: NOW });
    expect(out).toContain("1h 30m");
  });

  it("footer reports totals, worst-offender lateness, and hidden rows under a limit", () => {
    const jobs = [
      job({ id: "j1", resetAt: at(-4 * 3_600_000) }),
      job({ id: "j2", resetAt: at(-2 * 3_600_000) }),
      job({ id: "j3", resetAt: at(-30 * 60_000) }),
    ];
    const out = renderOverdue(report(jobs, { limit: 1 }), { now: NOW });
    expect(out).toContain("3 jobs overdue");
    expect(out).toContain("worst 4h 0m late");
    expect(out).toContain("2 more not shown");
  });

  it("does not emit ANSI escapes when color is off", () => {
    const out = renderOverdue(report([job()]), { now: NOW, color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no escapes.
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe("renderOverdueJson", () => {
  it("emits the store path, report, and honest totals", () => {
    const r = report([job({ id: "j1", resetAt: at(-60 * 60_000) })], { limit: 1 });
    const parsed = JSON.parse(
      renderOverdueJson({ storePath: "/tmp/jobs.json", generatedAt: "2026-07-30T10:00:00.000Z", report: r })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.report.entries).toHaveLength(1);
    expect(parsed.report.entries[0].job.id).toBe("j1");
    expect(parsed.report.totalOverdue).toBe(1);
    expect(parsed.report.maxOverdueByMs).toBe(60 * 60 * 1000);
  });

  it("includes the scope when one is passed", () => {
    const parsed = JSON.parse(
      renderOverdueJson({
        storePath: "/tmp/jobs.json",
        scope: { projects: ["demo"] },
        report: report([]),
      })
    );
    expect(parsed.scope).toEqual({ projects: ["demo"] });
  });
});
