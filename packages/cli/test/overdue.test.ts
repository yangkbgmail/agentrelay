import type { OverdueReport, RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_WAITING_MESSAGE, NONE_OVERDUE_MESSAGE, renderOverdue, renderOverdueJson } from "../src/overdue.js";

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "abcdef1234567890",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "waiting_for_reset",
    resetAt: "2026-07-13T11:30:00.000Z",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function report(overrides: Partial<OverdueReport> = {}): OverdueReport {
  return {
    totalWaiting: 1,
    overdueCount: 1,
    graceMs: 0,
    jobs: [{ job: job(), overdueMs: 30 * 60_000 }],
    ...overrides,
  };
}

describe("renderOverdue", () => {
  it("shows the empty message when nothing is waiting for a reset", () => {
    const out = renderOverdue(report({ totalWaiting: 0, overdueCount: 0, jobs: [] }));
    expect(out).toContain(NO_WAITING_MESSAGE);
  });

  it("shows the on-schedule message when jobs wait but none are overdue", () => {
    const out = renderOverdue(report({ totalWaiting: 3, overdueCount: 0, jobs: [] }));
    expect(out).toContain(NONE_OVERDUE_MESSAGE);
    expect(out).toContain("3 job(s) waiting");
  });

  it("lists an overdue job with its short id, project and lateness", () => {
    const out = renderOverdue(report());
    expect(out).toContain("abcdef12");
    expect(out).toContain("demo");
    expect(out).toContain("30m 0s overdue");
    expect(out).toContain("2026-07-13T11:30:00.000Z");
  });

  it("prompts to check the daemon and reports the overdue/total split", () => {
    const out = renderOverdue(
      report({
        totalWaiting: 5,
        overdueCount: 2,
        jobs: [
          { job: job({ id: "aaa" }), overdueMs: 60_000 },
          { job: job({ id: "bbb" }), overdueMs: 30_000 },
        ],
      })
    );
    expect(out).toContain("2 of 5 waiting job(s) are overdue");
    expect(out).toContain("Is the daemon running?");
  });

  it("notes the grace window when one is set", () => {
    const out = renderOverdue(report({ graceMs: 5 * 60_000 }));
    expect(out).toContain("grace 5m 0s");
  });

  it("applies --limit and appends a 'more not shown' footer", () => {
    const jobs = [
      { job: job({ id: "a" }), overdueMs: 3 * 60_000 },
      { job: job({ id: "b" }), overdueMs: 2 * 60_000 },
      { job: job({ id: "c" }), overdueMs: 1 * 60_000 },
    ];
    const out = renderOverdue(report({ totalWaiting: 3, overdueCount: 3, jobs }), { limit: 1 });
    expect(out).toContain("2 more overdue job(s) not shown");
  });

  it("prints a scope note when provided", () => {
    const out = renderOverdue(report(), { scopeNote: "tool=claude-code" });
    expect(out).toContain("scope: tool=claude-code");
  });

  it("emits no ANSI codes when color is off", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderOverdue(report(), { color: false })).not.toMatch(/\x1b\[/);
  });
});

describe("renderOverdueJson", () => {
  it("produces valid JSON with the store path, totals and jobs", () => {
    const parsed = JSON.parse(
      renderOverdueJson(report(), "/tmp/store.json", { generatedAt: "2026-07-13T12:00:00.000Z" })
    );
    expect(parsed.store).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-13T12:00:00.000Z");
    expect(parsed.scope).toBeNull();
    expect(parsed.totalWaiting).toBe(1);
    expect(parsed.overdueCount).toBe(1);
    expect(parsed.jobs[0].job.project).toBe("demo");
    expect(parsed.jobs[0].overdueMs).toBe(30 * 60_000);
  });

  it("echoes an active scope note", () => {
    const parsed = JSON.parse(renderOverdueJson(report(), "/tmp/store.json", { scopeNote: "project=demo" }));
    expect(parsed.scope).toBe("project=demo");
  });
});
