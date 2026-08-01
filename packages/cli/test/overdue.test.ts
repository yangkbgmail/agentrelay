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
    resetAt: at(-60 * 60_000),
    createdAt: at(-3 * 3_600_000),
    updatedAt: at(-3 * 3_600_000),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function report(jobs: RelayJob[], options: { graceMs?: number; limit?: number } = {}): OverdueReport {
  return buildOverdueReport(jobs, NOW, options);
}

describe("renderOverdue", () => {
  it("shows the healthy empty message when nothing is overdue", () => {
    expect(renderOverdue(report([]))).toBe(NO_OVERDUE_MESSAGE);
  });

  it("notes the grace and scope on the empty message when set", () => {
    const out = renderOverdue(report([], { graceMs: 5 * 60_000 }), { scopeNote: "project=ghost" });
    expect(out).toContain(NO_OVERDUE_MESSAGE);
    expect(out).toContain("grace: 5m 0s");
    expect(out).toContain("scope: project=ghost");
  });

  it("renders one row per overdue job, most overdue first, with ranks", () => {
    const out = renderOverdue(
      report([
        job({ id: "recent00", project: "recent-app", resetAt: at(-30 * 60_000) }),
        job({ id: "ancient0", project: "ancient-app", resetAt: at(-4 * 3_600_000) }),
      ])
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("OVERDUE BY");
    expect(out.indexOf("ancient-app")).toBeLessThan(out.indexOf("recent-app"));
    expect(out).toContain("1  ");
    expect(out).toContain("2  ");
  });

  it("reuses the shared duration format for the overdue lag", () => {
    const out = renderOverdue(report([job({ resetAt: at(-90 * 60_000) })]));
    expect(out).toContain("1h 30m");
  });

  it("footer reports total, worst lag, grace, and hidden rows under a limit", () => {
    const jobs = [
      job({ id: "j1", resetAt: at(-4 * 3_600_000) }),
      job({ id: "j2", resetAt: at(-2 * 3_600_000) }),
      job({ id: "j3", resetAt: at(-1 * 3_600_000) }),
    ];
    const out = renderOverdue(report(jobs, { graceMs: 10 * 60_000, limit: 1 }));
    expect(out).toContain("3 jobs overdue");
    expect(out).toContain("worst 4h 0m behind");
    expect(out).toContain("grace 10m 0s");
    expect(out).toContain("2 more not shown");
  });

  it("does not emit ANSI escapes when color is off", () => {
    const out = renderOverdue(report([job()]), { color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no escapes.
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe("renderOverdueJson", () => {
  it("emits the store path, report, and honest totals", () => {
    const r = report([job({ id: "j1", resetAt: at(-2 * 3_600_000) })]);
    const parsed = JSON.parse(
      renderOverdueJson({ storePath: "/tmp/jobs.json", generatedAt: "2026-07-30T10:00:00.000Z", report: r })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.report.entries).toHaveLength(1);
    expect(parsed.report.entries[0].job.id).toBe("j1");
    expect(parsed.report.totalOverdue).toBe(1);
    expect(parsed.report.worstOverdueMs).toBe(2 * 3_600_000);
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
