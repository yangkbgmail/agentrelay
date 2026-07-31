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
    createdAt: at(-2 * 3_600_000),
    updatedAt: at(-2 * 3_600_000),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function report(jobs: RelayJob[], opts?: { graceMs?: number; limit?: number }): OverdueReport {
  return buildOverdueReport(jobs, NOW, opts);
}

describe("renderOverdue", () => {
  it("shows the healthy message when nothing is overdue", () => {
    expect(renderOverdue(report([]))).toBe(NO_OVERDUE_MESSAGE);
  });

  it("appends the scope note and grace to the healthy message", () => {
    const out = renderOverdue(report([], { graceMs: 5 * 60_000 }), { scopeNote: "project=ghost" });
    expect(out).toContain(NO_OVERDUE_MESSAGE);
    expect(out).toContain("scope: project=ghost");
    expect(out).toContain("grace 5m");
  });

  it("renders one row per overdue job worst-first with ranks", () => {
    const out = renderOverdue(
      report([
        job({ id: "recent00", project: "recent-app", resetAt: at(-30 * 60_000) }),
        job({ id: "ancient0", project: "ancient-app", resetAt: at(-5 * 3_600_000) }),
      ])
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("OVERDUE BY");
    // Most-overdue (ancient) first.
    expect(out.indexOf("ancient-app")).toBeLessThan(out.indexOf("recent-app"));
    expect(out).toContain("1  ");
    expect(out).toContain("2  ");
  });

  it("formats the overdue duration with the shared helper", () => {
    const out = renderOverdue(report([job({ resetAt: at(-90 * 60_000) })]));
    expect(out).toContain("1h 30m");
  });

  it("footer reports totals, worst-late, and hidden rows under a limit", () => {
    const jobs = [
      job({ id: "j1", resetAt: at(-4 * 3_600_000) }),
      job({ id: "j2", resetAt: at(-2 * 3_600_000) }),
      job({ id: "j3", resetAt: at(-1 * 3_600_000) }),
    ];
    const out = renderOverdue(report(jobs, { limit: 1 }));
    expect(out).toContain("3 jobs overdue");
    expect(out).toContain("worst 4h 0m late");
    expect(out).toContain("2 more not shown");
  });

  it("hints at the stalled resume loop when jobs are overdue", () => {
    const out = renderOverdue(report([job()]));
    expect(out).toContain("agentrelay health");
  });

  it("does not emit ANSI escapes when color is off", () => {
    const out = renderOverdue(report([job()]), { color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no escapes.
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe("renderOverdueJson", () => {
  it("emits the store path, report, and honest totals", () => {
    const r = report([job({ id: "j1", resetAt: at(-3 * 3_600_000) })], { limit: 1 });
    const parsed = JSON.parse(
      renderOverdueJson({ storePath: "/tmp/jobs.json", generatedAt: "2026-07-30T10:00:00.000Z", report: r })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.report.entries).toHaveLength(1);
    expect(parsed.report.entries[0].job.id).toBe("j1");
    expect(parsed.report.totalOverdue).toBe(1);
    expect(parsed.report.worstOverdueMs).toBe(3 * 3_600_000);
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
