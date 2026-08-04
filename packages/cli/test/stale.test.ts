import { buildStaleReport, type RelayJob, type StaleReport } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_STALE_MESSAGE, renderStale, renderStaleJson } from "../src/stale.js";

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
    status: "resuming",
    resetAt: null,
    createdAt: at(-3 * 3_600_000),
    updatedAt: at(-90 * 60_000),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function report(jobs: RelayJob[], options: { thresholdMs?: number; limit?: number } = {}): StaleReport {
  return buildStaleReport(jobs, NOW, options);
}

describe("renderStale", () => {
  it("shows the clean message when nothing is stale", () => {
    expect(renderStale(report([]))).toBe(NO_STALE_MESSAGE);
  });

  it("appends the scope note to the empty message when scoped", () => {
    const out = renderStale(report([]), { scopeNote: "project=ghost" });
    expect(out).toContain(NO_STALE_MESSAGE);
    expect(out).toContain("scope: project=ghost");
  });

  it("notes the threshold in the empty message when one is set", () => {
    const out = renderStale(report([], { thresholdMs: 60 * 1000 }));
    expect(out).toContain("threshold 1m 0s");
  });

  it("renders one row per stale job, longest-stuck first", () => {
    const out = renderStale(
      report([
        job({ id: "recent00", project: "recent-app", updatedAt: at(-30 * 60_000) }),
        job({ id: "ancient0", project: "ancient-app", updatedAt: at(-4 * 3_600_000) }),
      ])
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("PROJECT");
    expect(lines[0]).toContain("STUCK FOR");
    expect(out.indexOf("ancient-app")).toBeLessThan(out.indexOf("recent-app"));
  });

  it("reuses the shared duration format for the stuck span", () => {
    const out = renderStale(report([job({ updatedAt: at(-2 * 3_600_000 - 5 * 60_000) })]));
    expect(out).toContain("2h 5m");
  });

  it("footer reports totals, worst span, and hidden rows under a limit", () => {
    const jobs = [
      job({ id: "j1", updatedAt: at(-4 * 3_600_000) }),
      job({ id: "j2", updatedAt: at(-2 * 3_600_000) }),
      job({ id: "j3", updatedAt: at(-60 * 60_000) }),
    ];
    const out = renderStale(report(jobs, { limit: 1 }));
    expect(out).toContain("3 jobs stale");
    expect(out).toContain("worst 4h 0m");
    expect(out).toContain("2 more not shown");
    expect(out).toContain("agentrelay health");
  });

  it("does not emit ANSI escapes when color is off", () => {
    const out = renderStale(report([job()]), { color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no escapes.
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe("renderStaleJson", () => {
  it("emits the store path, report, and honest totals", () => {
    const r = report([job({ id: "j1", updatedAt: at(-60 * 60_000) })], { limit: 1 });
    const parsed = JSON.parse(
      renderStaleJson({ storePath: "/tmp/jobs.json", generatedAt: "2026-07-30T10:00:00.000Z", report: r })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.report.entries).toHaveLength(1);
    expect(parsed.report.entries[0].job.id).toBe("j1");
    expect(parsed.report.totalStale).toBe(1);
    expect(parsed.report.maxStuckForMs).toBe(60 * 60_000);
  });

  it("includes the scope when one is passed", () => {
    const parsed = JSON.parse(
      renderStaleJson({
        storePath: "/tmp/jobs.json",
        scope: { projects: ["demo"] },
        report: report([]),
      })
    );
    expect(parsed.scope).toEqual({ projects: ["demo"] });
  });
});
