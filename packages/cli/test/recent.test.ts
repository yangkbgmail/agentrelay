import { buildRecentActivity, type RecentReport, type RelayJob } from "@agentrelay/core";
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

function report(jobs: RelayJob[], options: { limit?: number } = {}): RecentReport {
  return buildRecentActivity(jobs, NOW, options);
}

describe("renderRecent", () => {
  it("shows the empty message when nothing has resolved", () => {
    expect(renderRecent(report([]))).toBe(NO_RECENT_MESSAGE);
  });

  it("appends the scope note to the empty message when scoped", () => {
    const out = renderRecent(report([]), { scopeNote: "project=ghost" });
    expect(out).toContain(NO_RECENT_MESSAGE);
    expect(out).toContain("scope: project=ghost");
  });

  it("renders one row per resolved job, most-recent first", () => {
    const out = renderRecent(
      report([
        job({ id: "older000", project: "older-app", updatedAt: at(-5 * 3_600_000) }),
        job({ id: "newer000", project: "newer-app", updatedAt: at(-10 * 60_000) }),
      ])
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("PROJECT");
    expect(lines[0]).toContain("STATUS");
    expect(lines[0]).toContain("WHEN");
    expect(out.indexOf("newer-app")).toBeLessThan(out.indexOf("older-app"));
  });

  it("renders a relative 'ago' age and the resolution span", () => {
    const out = renderRecent(
      report([job({ createdAt: at(-3 * 3_600_000), updatedAt: at(-2 * 3_600_000 - 5 * 60_000) })])
    );
    expect(out).toContain("2h 5m ago"); // age since updatedAt
    expect(out).toContain("55m 0s"); // took: updatedAt − createdAt = 55m
  });

  it("shows 'just now' for a sub-second age", () => {
    const out = renderRecent(report([job({ updatedAt: at(-200) })]));
    expect(out).toContain("just now");
  });

  it("shows a dash for an unknown resolution span", () => {
    const out = renderRecent(report([job({ createdAt: at(1000), updatedAt: at(-1000) })]));
    // createdAt after updatedAt -> negative span -> null -> "-"
    const rowLine = out.split("\n").find((l) => l.includes("abcdef12"));
    expect(rowLine).toContain("-");
  });

  it("footer reports totals and hidden rows under a limit", () => {
    const jobs = [
      job({ id: "j1", updatedAt: at(-10 * 60_000) }),
      job({ id: "j2", updatedAt: at(-20 * 60_000) }),
      job({ id: "j3", updatedAt: at(-30 * 60_000) }),
    ];
    const out = renderRecent(report(jobs, { limit: 1 }));
    expect(out).toContain("3 resolved jobs");
    expect(out).toContain("2 more not shown");
  });

  it("does not emit ANSI escapes when color is off", () => {
    const out = renderRecent(report([job()]), { color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no escapes.
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe("renderRecentJson", () => {
  it("emits the store path, report, and honest totals", () => {
    const r = report([job({ id: "j1", updatedAt: at(-10 * 60_000) })], { limit: 1 });
    const parsed = JSON.parse(
      renderRecentJson({ storePath: "/tmp/jobs.json", generatedAt: "2026-07-30T10:00:00.000Z", report: r })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.report.entries).toHaveLength(1);
    expect(parsed.report.entries[0].job.id).toBe("j1");
    expect(parsed.report.total).toBe(1);
  });

  it("includes the scope when one is passed", () => {
    const parsed = JSON.parse(
      renderRecentJson({ storePath: "/tmp/jobs.json", scope: { projects: ["demo"] }, report: report([]) })
    );
    expect(parsed.scope).toEqual({ projects: ["demo"] });
  });
});
