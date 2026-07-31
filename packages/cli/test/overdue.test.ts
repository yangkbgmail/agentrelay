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
    resetAt: at(-30 * 60_000),
    createdAt: at(-60 * 60_000),
    updatedAt: at(-60 * 60_000),
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
  it("shows the empty message with the grace note when nothing is overdue", () => {
    const out = renderOverdue(report([]), {});
    expect(out).toContain(NO_OVERDUE_MESSAGE);
    expect(out).toContain("grace 1m 0s");
  });

  it("appends the scope note to the empty message when scoped", () => {
    const out = renderOverdue(report([]), { scopeNote: "project=ghost" });
    expect(out).toContain(NO_OVERDUE_MESSAGE);
    expect(out).toContain("scope: project=ghost");
  });

  it("renders one row per overdue job, most overdue first, with positions", () => {
    const out = renderOverdue(
      report([
        job({ id: "recent00", project: "recent-app", resetAt: at(-5 * 60_000) }),
        job({ id: "ancient0", project: "ancient-app", resetAt: at(-3 * 3_600_000) }),
      ]),
      {}
    );
    expect(out.indexOf("ancient-app")).toBeLessThan(out.indexOf("recent-app"));
    expect(out).toContain("PROJECT");
    expect(out).toContain("1  ");
    expect(out).toContain("2  ");
  });

  it("formats how long each job has been overdue", () => {
    const out = renderOverdue(report([job({ resetAt: at(-90 * 60_000) })]), {});
    expect(out).toContain("1h 30m");
  });

  it("footer reports totals, the longest overdue, and hidden rows under a limit", () => {
    const jobs = [
      job({ id: "j1", resetAt: at(-60 * 60_000) }),
      job({ id: "j2", resetAt: at(-50 * 60_000) }),
      job({ id: "j3", resetAt: at(-40 * 60_000) }),
    ];
    const out = renderOverdue(report(jobs, { limit: 1 }), {});
    expect(out).toContain("3 jobs overdue");
    expect(out).toContain("longest 1h 0m");
    expect(out).toContain("2 more not shown");
  });

  it("renders the grace window as 0s when zero", () => {
    const out = renderOverdue(report([], { graceMs: 0 }), {});
    expect(out).toContain("grace 0s");
  });

  it("does not emit ANSI escapes when color is off", () => {
    const out = renderOverdue(report([job()]), { color: false });
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
    expect(parsed.report.graceMs).toBe(60_000);
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
