import { findOverdueJobs, type OverdueReport, type RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { formatLateBy, NO_OVERDUE_MESSAGE, renderOverdue, renderOverdueJson } from "../src/overdue.js";

const NOW = Date.parse("2026-07-30T10:00:00.000Z");
const HOUR = 3_600_000;

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
    resetAt: at(-HOUR),
    createdAt: at(-2 * HOUR),
    updatedAt: at(-2 * HOUR),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function report(jobs: RelayJob[], stuckResumingMs: number | null = HOUR): OverdueReport {
  return findOverdueJobs(jobs, NOW, { graceMs: 0, stuckResumingMs });
}

describe("formatLateBy", () => {
  it("renders sub-minute spans in seconds", () => {
    expect(formatLateBy(0)).toBe("0s");
    expect(formatLateBy(500)).toBe("0s");
    expect(formatLateBy(5_000)).toBe("5s");
    expect(formatLateBy(59_000)).toBe("59s");
  });

  it("renders minutes, hours, and days like formatCountdown", () => {
    expect(formatLateBy(90_000)).toBe("1m");
    expect(formatLateBy(63 * 60_000)).toBe("1h 3m");
    expect(formatLateBy(50 * HOUR)).toBe("2d 2h");
  });
});

describe("renderOverdue", () => {
  it("shows the healthy message when nothing is overdue", () => {
    expect(renderOverdue(report([]))).toBe(NO_OVERDUE_MESSAGE);
  });

  it("appends the scope note to the healthy message when scoped", () => {
    const out = renderOverdue(report([]), { scopeNote: "project=ghost" });
    expect(out).toContain(NO_OVERDUE_MESSAGE);
    expect(out).toContain("project=ghost");
  });

  it("renders a past-due reset row with its how-late span", () => {
    const out = renderOverdue(report([job({ id: "late1234", project: "api", resetAt: at(-HOUR) })]), {});
    expect(out).toContain("late1234");
    expect(out).toContain("api");
    expect(out).toContain("reset passed");
    expect(out).toContain("1h 0m");
    expect(out).toContain("1 job overdue");
    expect(out).toContain("1 past reset");
  });

  it("renders a stuck-resuming row anchored on updatedAt", () => {
    const stuck = job({ id: "stuck567", status: "resuming", resetAt: null, updatedAt: at(-3 * HOUR) });
    const out = renderOverdue(report([stuck]), {});
    expect(out).toContain("stuck567");
    expect(out).toContain("stuck resuming");
    expect(out).toContain("3h 0m");
    expect(out).toContain("1 stuck resuming");
    expect(out).toContain(at(-3 * HOUR));
  });

  it("summarizes mixed reasons and the worst-late span in the footer", () => {
    const out = renderOverdue(
      report([
        job({ id: "a", resetAt: at(-HOUR) }),
        job({ id: "b", status: "resuming", resetAt: null, updatedAt: at(-4 * HOUR) }),
      ]),
      {}
    );
    expect(out).toContain("2 jobs overdue");
    expect(out).toContain("1 past reset");
    expect(out).toContain("1 stuck resuming");
    expect(out).toContain("worst 4h 0m late");
  });

  it("does not emit ANSI codes when color is off", () => {
    const out = renderOverdue(report([job({ resetAt: at(-HOUR) })]), { color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak into plain output
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe("renderOverdueJson", () => {
  it("wraps the report with store path, scope, and generatedAt", () => {
    const r = report([job({ id: "late", resetAt: at(-HOUR) })]);
    const out = renderOverdueJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-30T10:00:00.000Z",
      scope: { projects: ["demo"] },
      report: r,
    });
    const parsed = JSON.parse(out);
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.scope).toEqual({ projects: ["demo"] });
    expect(parsed.report.total).toBe(1);
    expect(parsed.report.entries[0].job.id).toBe("late");
    expect(parsed.report.entries[0].reason).toBe("reset-passed");
  });
});
