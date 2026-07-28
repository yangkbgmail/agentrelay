import type { OverdueReport, RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_OVERDUE_MESSAGE, renderOverdue, renderOverdueJson } from "../src/overdue.js";

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "abcdef1234567890",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "waiting_for_reset",
    resetAt: "2026-07-13T11:00:00.000Z",
    createdAt: "2026-07-13T09:00:00.000Z",
    updatedAt: "2026-07-13T09:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function report(overrides: Partial<OverdueReport> = {}): OverdueReport {
  return {
    jobs: [{ job: job(), overdueMs: 90 * 60_000 }],
    totalWaiting: 1,
    maxOverdueMs: 90 * 60_000,
    ...overrides,
  };
}

describe("renderOverdue", () => {
  it("shows the healthy message when nothing is waiting", () => {
    expect(renderOverdue({ jobs: [], totalWaiting: 0, maxOverdueMs: 0 })).toBe(NO_OVERDUE_MESSAGE);
  });

  it("notes waiting-but-not-overdue jobs when none are late", () => {
    const out = renderOverdue({ jobs: [], totalWaiting: 3, maxOverdueMs: 0 });
    expect(out).toContain(NO_OVERDUE_MESSAGE);
    expect(out).toContain("3 jobs waiting for a reset, none overdue.");
  });

  it("lists the overdue job with short id, project and duration", () => {
    const out = renderOverdue(report());
    expect(out).toContain("1 overdue job of 1 waiting for a reset");
    expect(out).toContain("abcdef12");
    expect(out).toContain("demo");
    expect(out).toContain("overdue 1h 30m");
    expect(out).toContain("reset 2026-07-13T11:00:00.000Z");
  });

  it("pluralizes the overdue count", () => {
    const out = renderOverdue(
      report({
        jobs: [
          { job: job({ id: "aaaaaaaa11" }), overdueMs: 90 * 60_000 },
          { job: job({ id: "bbbbbbbb22" }), overdueMs: 30 * 60_000 },
        ],
        totalWaiting: 5,
      })
    );
    expect(out).toContain("2 overdue jobs of 5 waiting for a reset");
  });

  it("hints at the daemon when jobs are overdue", () => {
    expect(renderOverdue(report())).toContain("agentrelay doctor");
  });

  it("emits no ANSI codes when color is off", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderOverdue(report(), { color: false })).not.toMatch(/\x1b\[/);
  });
});

describe("renderOverdueJson", () => {
  it("produces valid JSON with the store path and full report", () => {
    const parsed = JSON.parse(
      renderOverdueJson(report(), "/tmp/store.json", { generatedAt: "2026-07-13T12:30:00.000Z" })
    );
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-13T12:30:00.000Z");
    expect(parsed.scope).toBeNull();
    expect(parsed.totalWaiting).toBe(1);
    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.jobs[0].job.project).toBe("demo");
    expect(parsed.jobs[0].overdueMs).toBe(90 * 60_000);
  });

  it("echoes an active scope note", () => {
    const parsed = JSON.parse(renderOverdueJson(report(), "/tmp/store.json", { scopeNote: "tool=claude-code" }));
    expect(parsed.scope).toBe("tool=claude-code");
  });
});
