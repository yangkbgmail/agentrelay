import { buildRecentReport, type RecentReport, type RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_RECENT_MESSAGE, renderRecent, renderRecentJson } from "../src/recent.js";

const NOW = Date.parse("2026-07-30T12:00:00.000Z");

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
    createdAt: at(-2 * 3_600_000),
    updatedAt: at(-1 * 3_600_000),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function report(jobs: RelayJob[], limit?: number): RecentReport {
  return buildRecentReport(jobs, NOW, limit);
}

describe("renderRecent", () => {
  it("shows the empty message when nothing has finished", () => {
    expect(renderRecent(report([]))).toBe(NO_RECENT_MESSAGE);
  });

  it("appends the scope note to the empty message when scoped", () => {
    const out = renderRecent(report([]), { scopeNote: "status=completed" });
    expect(out).toContain(NO_RECENT_MESSAGE);
    expect(out).toContain("scope: status=completed");
  });

  it("renders one row per finished job, newest first, with positions", () => {
    const out = renderRecent(
      report([
        job({ id: "old00000", project: "old-app", updatedAt: at(-5 * 3_600_000) }),
        job({ id: "new00000", project: "new-app", updatedAt: at(-1 * 3_600_000) }),
      ])
    );
    expect(out).toContain("PROJECT");
    expect(out).toContain("STATUS");
    expect(out).toContain("TOOK");
    expect(out.indexOf("new-app")).toBeLessThan(out.indexOf("old-app"));
    expect(out).toContain("1  ");
    expect(out).toContain("2  ");
  });

  it("reuses the shared duration format for TOOK and FINISHED", () => {
    const out = renderRecent(report([job({ createdAt: at(-150 * 60_000), updatedAt: at(-60 * 60_000) })]));
    expect(out).toContain("1h 30m"); // took 90m
    expect(out).toContain("1h 0m ago"); // finished 60m ago
  });

  it("shows '-' for TOOK when the span is unusable", () => {
    const out = renderRecent(report([job({ createdAt: at(-1 * 3_600_000), updatedAt: at(-2 * 3_600_000) })]));
    const bodyLine = out.split("\n").find((l) => l.includes("demo"));
    expect(bodyLine).toContain("-");
  });

  it("footer reports totals, average, and hidden rows under a limit", () => {
    const jobs = [
      job({ id: "j1", createdAt: at(-9 * 3_600_000), updatedAt: at(-1 * 3_600_000) }),
      job({ id: "j2", createdAt: at(-10 * 3_600_000), updatedAt: at(-2 * 3_600_000) }),
      job({ id: "j3", createdAt: at(-11 * 3_600_000), updatedAt: at(-3 * 3_600_000) }),
    ];
    const out = renderRecent(report(jobs, 1));
    expect(out).toContain("3 jobs resolved");
    expect(out).toContain("avg took");
    expect(out).toContain("2 more not shown");
  });

  it("does not emit ANSI escapes when color is off", () => {
    const out = renderRecent(report([job({ status: "failed" })]), { color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no escapes.
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("colors the status cell and keeps columns aligned when color is on", () => {
    const out = renderRecent(report([job({ status: "failed" })]), { color: true });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting escapes are present.
    expect(out).toMatch(/\x1b\[/);
    expect(out).toContain("failed");
  });
});

describe("renderRecentJson", () => {
  it("emits the store path, report, and honest totals", () => {
    const r = report([job({ id: "j1", createdAt: at(-2 * 3_600_000), updatedAt: at(-1 * 3_600_000) })], 1);
    const parsed = JSON.parse(
      renderRecentJson({ storePath: "/tmp/jobs.json", generatedAt: "2026-07-30T12:00:00.000Z", report: r })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T12:00:00.000Z");
    expect(parsed.report.entries).toHaveLength(1);
    expect(parsed.report.entries[0].job.id).toBe("j1");
    expect(parsed.report.totalResolved).toBe(1);
    expect(parsed.report.avgResolutionMs).toBe(60 * 60 * 1000);
  });

  it("includes the scope when one is passed", () => {
    const parsed = JSON.parse(
      renderRecentJson({ storePath: "/tmp/jobs.json", scope: { statuses: ["failed"] }, report: report([]) })
    );
    expect(parsed.scope).toEqual({ statuses: ["failed"] });
  });
});
