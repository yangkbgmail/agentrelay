import { buildOverdueReport, type OverdueReport, type RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_OVERDUE_MESSAGE, renderOverdue, renderOverdueJson, renderOverdueWatchFrame } from "../src/overdue.js";

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
  it("shows the keeping-up message when nothing is overdue", () => {
    expect(renderOverdue(report([]))).toBe(NO_OVERDUE_MESSAGE);
  });

  it("appends the scope note to the empty message when scoped", () => {
    const out = renderOverdue(report([]), { scopeNote: "project=ghost" });
    expect(out).toContain(NO_OVERDUE_MESSAGE);
    expect(out).toContain("scope: project=ghost");
  });

  it("notes the grace window in the empty message when one is set", () => {
    const out = renderOverdue(report([], { graceMs: 60 * 1000 }));
    expect(out).toContain("grace 1m 0s");
  });

  it("renders one row per overdue job, most-overdue first", () => {
    const out = renderOverdue(
      report([
        job({ id: "recent00", project: "recent-app", resetAt: at(-30 * 60_000) }),
        job({ id: "ancient0", project: "ancient-app", resetAt: at(-4 * 3_600_000) }),
      ])
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("PROJECT");
    expect(lines[0]).toContain("OVERDUE BY");
    expect(out.indexOf("ancient-app")).toBeLessThan(out.indexOf("recent-app"));
  });

  it("reuses the shared duration format for the overdue span", () => {
    const out = renderOverdue(report([job({ resetAt: at(-2 * 3_600_000 - 5 * 60_000) })]));
    expect(out).toContain("2h 5m");
  });

  it("footer reports totals, worst span, and hidden rows under a limit", () => {
    const jobs = [
      job({ id: "j1", resetAt: at(-4 * 3_600_000) }),
      job({ id: "j2", resetAt: at(-2 * 3_600_000) }),
      job({ id: "j3", resetAt: at(-60 * 60_000) }),
    ];
    const out = renderOverdue(report(jobs, { limit: 1 }));
    expect(out).toContain("3 jobs overdue");
    expect(out).toContain("worst 4h 0m");
    expect(out).toContain("2 more not shown");
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
    const r = report([job({ id: "j1", resetAt: at(-60 * 60_000) })], { limit: 1 });
    const parsed = JSON.parse(
      renderOverdueJson({ storePath: "/tmp/jobs.json", generatedAt: "2026-07-30T10:00:00.000Z", report: r })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.report.entries).toHaveLength(1);
    expect(parsed.report.entries[0].job.id).toBe("j1");
    expect(parsed.report.totalOverdue).toBe(1);
    expect(parsed.report.maxOverdueByMs).toBe(60 * 60_000);
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

describe("renderOverdueWatchFrame", () => {
  it("renders a live title/meta header above the report body", () => {
    const frame = renderOverdueWatchFrame(report([job()]), "/tmp/jobs.json", 2000, NOW);
    const lines = frame.split("\n");
    expect(lines[0]).toContain("agentrelay overdue");
    expect(lines[0]).toContain("live, every 2s");
    expect(lines[0]).toContain("Ctrl-C to exit");
    // The meta line carries the frame timestamp and the store path.
    expect(lines[1]).toContain("2026-07-30 10:00:00Z");
    expect(lines[1]).toContain("/tmp/jobs.json");
    // The body is the colored report — the overdue span shows through.
    expect(frame).toContain("OVERDUE BY");
  });

  it("rounds the interval to whole seconds in the banner", () => {
    const frame = renderOverdueWatchFrame(report([]), "/tmp/jobs.json", 5000, NOW);
    expect(frame).toContain("live, every 5s");
  });

  it("passes the scope note through to the report body", () => {
    const frame = renderOverdueWatchFrame(report([]), "/tmp/jobs.json", 2000, NOW, "project=demo");
    expect(frame).toContain("scope: project=demo");
  });
});
