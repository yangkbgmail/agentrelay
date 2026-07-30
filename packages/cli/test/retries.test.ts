import { buildRetriesReport, type RelayJob, type RetriesReport } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_RETRIES_MESSAGE, renderRetries, renderRetriesJson } from "../src/retries.js";

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "abcdef1234567890",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "failed",
    resetAt: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 3,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function report(jobs: RelayJob[], opts: { minAttempts?: number; limit?: number } = {}): RetriesReport {
  return buildRetriesReport(jobs, opts);
}

describe("renderRetries", () => {
  it("shows the empty message (with floor) when nothing has been retried", () => {
    const out = renderRetries(report([job({ attempts: 1 })]));
    expect(out).toContain(NO_RETRIES_MESSAGE);
    expect(out).toContain("min attempts: 2");
  });

  it("appends the scope note to the empty message when scoped", () => {
    const out = renderRetries(report([]), { scopeNote: "project=ghost" });
    expect(out).toContain(NO_RETRIES_MESSAGE);
    expect(out).toContain("scope: project=ghost");
  });

  it("renders one row per retried job, most retried first, with positions", () => {
    const out = renderRetries(
      report([
        job({ id: "mild0000", project: "mild-app", attempts: 2 }),
        job({ id: "worst000", project: "worst-app", attempts: 6 }),
      ])
    );
    expect(out).toContain("PROJECT");
    expect(out).toContain("ATTEMPTS");
    expect(out.indexOf("worst-app")).toBeLessThan(out.indexOf("mild-app"));
    expect(out).toContain("1  ");
    expect(out).toContain("2  ");
  });

  it("footer reports the qualifying total, budget spent, max, and hidden rows under a limit", () => {
    const jobs = [job({ id: "j1", attempts: 2 }), job({ id: "j2", attempts: 3 }), job({ id: "j3", attempts: 5 })];
    const out = renderRetries(report(jobs, { limit: 1 }));
    expect(out).toContain("3 jobs retried");
    expect(out).toContain("10 attempts total");
    expect(out).toContain("max 5");
    expect(out).toContain("2 more not shown");
  });

  it("uses singular 'job' in the footer for a single retried job", () => {
    const out = renderRetries(report([job({ attempts: 2 })]));
    expect(out).toContain("1 job retried");
  });

  it("does not emit ANSI escapes when color is off", () => {
    const out = renderRetries(report([job({ attempts: 2 })]), { color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no escapes.
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe("renderRetriesJson", () => {
  it("emits the store path, report, floor, and honest totals", () => {
    const r = report([job({ id: "j1", attempts: 4 }), job({ id: "j2", attempts: 2 })], { limit: 1 });
    const parsed = JSON.parse(
      renderRetriesJson({ storePath: "/tmp/jobs.json", generatedAt: "2026-07-30T10:00:00.000Z", report: r })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.report.entries).toHaveLength(1);
    expect(parsed.report.entries[0].job.id).toBe("j1");
    expect(parsed.report.totalRetried).toBe(2);
    expect(parsed.report.minAttempts).toBe(2);
    expect(parsed.report.totalAttempts).toBe(6);
    expect(parsed.report.maxAttempts).toBe(4);
  });

  it("includes the scope when one is passed", () => {
    const parsed = JSON.parse(
      renderRetriesJson({
        storePath: "/tmp/jobs.json",
        scope: { projects: ["demo"] },
        report: report([]),
      })
    );
    expect(parsed.scope).toEqual({ projects: ["demo"] });
  });
});
