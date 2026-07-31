import { buildOverdueReport, type OverdueReport, type RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { formatElapsed, NO_OVERDUE_MESSAGE, OVERDUE_HINT, renderOverdue, renderOverdueJson } from "../src/overdue.js";

const NOW = Date.parse("2026-07-30T12:30:00.000Z");

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
    resetAt: at(-30 * 60_000), // 30 min overdue by default
    createdAt: at(-3_600_000),
    updatedAt: at(-3_600_000),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function report(jobs: RelayJob[]): OverdueReport {
  return buildOverdueReport(jobs, NOW);
}

describe("formatElapsed", () => {
  it("renders seconds, minutes, hours, and days compactly", () => {
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(7 * 60_000)).toBe("7m");
    expect(formatElapsed(4 * 3_600_000 + 12 * 60_000)).toBe("4h 12m");
    expect(formatElapsed(2 * 86_400_000 + 3 * 3_600_000)).toBe("2d 3h");
  });
});

describe("renderOverdue", () => {
  it("shows the healthy message when nothing is overdue", () => {
    expect(renderOverdue(report([]))).toBe(NO_OVERDUE_MESSAGE);
  });

  it("prefixes the scope note to the healthy message when scoped", () => {
    const out = renderOverdue(report([]), { scopeNote: "project=ghost" });
    expect(out).toContain(NO_OVERDUE_MESSAGE);
    expect(out).toContain("scope: project=ghost");
  });

  it("renders a row per overdue job with kind, id, project, and overdue span", () => {
    const out = renderOverdue(
      report([
        job({ id: "waiting1", project: "web", resetAt: at(-30 * 60_000) }),
        job({ id: "stuck111", project: "api", status: "resuming", resetAt: null, updatedAt: at(-20 * 60_000) }),
      ])
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("KIND");
    expect(lines[0]).toContain("OVERDUE BY");
    // Worst-first: the 30-min waiting job leads the 20-min stuck one.
    expect(out.indexOf("waiting1")).toBeLessThan(out.indexOf("stuck111"));
    expect(out).toContain("waiting");
    expect(out).toContain("resuming");
    expect(out).toContain("30m");
    expect(out).toContain("20m");
  });

  it("includes a footer with counts, thresholds, and the daemon hint", () => {
    const out = renderOverdue(report([job({ id: "late0000" })]));
    expect(out).toContain("1 overdue job");
    expect(out).toContain("grace 1m");
    expect(out).toContain("stale 5m");
    expect(out).toContain(OVERDUE_HINT);
  });

  it("emits no ANSI codes when color is off and includes them when on", () => {
    const plain = renderOverdue(report([job()]), { color: false });
    expect(plain).not.toContain("\x1b[");
    const colored = renderOverdue(report([job()]), { color: true });
    expect(colored).toContain("\x1b[");
  });
});

describe("renderOverdueJson", () => {
  it("wraps the report in an envelope with store path, timestamp, and scope", () => {
    const json = renderOverdueJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-30T12:30:00.000Z",
      scope: { projects: ["web"] },
      report: report([job({ id: "late0000" })]),
    });
    const parsed = JSON.parse(json);
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T12:30:00.000Z");
    expect(parsed.scope).toEqual({ projects: ["web"] });
    expect(parsed.report.total).toBe(1);
    expect(parsed.report.entries[0].job.id).toBe("late0000");
  });
});
