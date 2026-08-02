import { type AttemptReport, buildAttemptReport, type RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_ATTEMPTS_MATCH_MESSAGE, NO_ATTEMPTS_MESSAGE, renderAttempts, renderAttemptsJson } from "../src/attempts.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `abcdef${seq}0000000`,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "waiting_for_reset",
    resetAt: "2026-07-30T09:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 2,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function report(
  jobs: RelayJob[],
  options: { maxAttempts?: number; riskThreshold?: number; limit?: number } = {}
): AttemptReport {
  return buildAttemptReport(jobs, options);
}

describe("renderAttempts", () => {
  it("shows the empty message when no job has been retried", () => {
    expect(renderAttempts(report([]))).toBe(NO_ATTEMPTS_MESSAGE);
  });

  it("uses the scoped empty message and appends the scope note when scoped", () => {
    const out = renderAttempts(report([]), { scopeNote: "project=ghost" });
    expect(out).toContain(NO_ATTEMPTS_MATCH_MESSAGE);
    expect(out).toContain("scope: project=ghost");
  });

  it("renders one row per retried job, most-attempted first", () => {
    const out = renderAttempts(
      report([job({ project: "low-app", attempts: 1 }), job({ project: "high-app", attempts: 5 })])
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("TRIES");
    expect(lines[0]).toContain("LEFT");
    expect(out.indexOf("high-app")).toBeLessThan(out.indexOf("low-app"));
  });

  it("shows attempts left against a finite budget and ∞ when unlimited", () => {
    const finite = renderAttempts(report([job({ attempts: 3 })], { maxAttempts: 5 }));
    // TRIES 3, LEFT 2
    expect(finite).toMatch(/3\s+2/);

    const unlimited = renderAttempts(report([job({ attempts: 3 })], { maxAttempts: 0 }));
    expect(unlimited).toContain("∞");
  });

  it("marks at-risk jobs with a leading ! and reports them in the footer", () => {
    const out = renderAttempts(report([job({ status: "waiting_for_reset", attempts: 4 })], { maxAttempts: 5 }));
    expect(out).toMatch(/^! /m);
    expect(out).toContain("1 at risk");
    expect(out).toContain("marked failed");
  });

  it("does not mark or warn when nothing is at risk", () => {
    const out = renderAttempts(report([job({ status: "queued", attempts: 1 })], { maxAttempts: 5 }));
    expect(out).not.toMatch(/^! /m);
    expect(out).not.toContain("at risk");
    expect(out).not.toContain("marked failed");
  });

  it("footer reports totals, budget, worst, and hidden rows under a limit", () => {
    const jobs = [job({ attempts: 5 }), job({ attempts: 4 }), job({ attempts: 3 })];
    const out = renderAttempts(report(jobs, { maxAttempts: 10, limit: 1 }));
    expect(out).toContain("3 jobs retried");
    expect(out).toContain("12 attempts total");
    expect(out).toContain("worst 5");
    expect(out).toContain("budget 10");
    expect(out).toContain("2 more not shown");
  });

  it("reports an unlimited budget in the footer", () => {
    const out = renderAttempts(report([job({ attempts: 2 })], { maxAttempts: 0 }));
    expect(out).toContain("budget unlimited");
  });

  it("does not emit ANSI escapes when color is off", () => {
    const out = renderAttempts(report([job({ status: "waiting_for_reset", attempts: 4 })], { maxAttempts: 5 }), {
      color: false,
    });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no escapes.
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe("renderAttemptsJson", () => {
  it("emits the store path, scope, and full report", () => {
    const r = report([job({ id: "abcdef99999999", attempts: 3 })], { maxAttempts: 5, limit: 1 });
    const parsed = JSON.parse(
      renderAttemptsJson({
        storePath: "/tmp/jobs.json",
        generatedAt: "2026-07-30T10:00:00.000Z",
        scope: { statuses: ["waiting_for_reset"] },
        report: r,
      })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.scope).toEqual({ statuses: ["waiting_for_reset"] });
    expect(parsed.report.maxAttempts).toBe(5);
    expect(parsed.report.withAttempts).toBe(1);
    expect(parsed.report.entries[0].attempts).toBe(3);
    expect(parsed.report.entries[0].remaining).toBe(2);
  });
});
