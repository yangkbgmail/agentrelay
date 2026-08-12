import type { RelayJob } from "@agentrelay/core";
import { summarizeBusiest } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_COMMANDS_MESSAGE, NO_SCOPE_MATCH_MESSAGE, renderBusiest, renderBusiestJson } from "./busiest.js";

// A fixed "now" so countdown assertions are deterministic.
const NOW = Date.parse("2026-08-10T12:00:00.000Z");

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/work",
    status: "completed",
    resetAt: null,
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("renderBusiest", () => {
  it("shows the empty-store hint when there are no jobs and no scope", () => {
    expect(renderBusiest(summarizeBusiest([]), { now: NOW })).toBe(NO_COMMANDS_MESSAGE);
  });

  it("shows the no-match hint when a scope filtered everything out", () => {
    const out = renderBusiest(summarizeBusiest([]), { now: NOW, scopeNote: "status=failed" });
    expect(out).toContain("scope: status=failed");
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
  });

  it("renders a headline with command, job, and attempt counts", () => {
    const out = renderBusiest(
      summarizeBusiest([
        job({ command: ["claude", "-p", "build"], attempts: 3 }),
        job({ command: ["codex", "run"], attempts: 1 }),
      ]),
      { now: NOW }
    );
    expect(out).toContain("2 commands");
    expect(out).toContain("across 2 jobs");
    expect(out).toContain("4 resume attempts");
    expect(out).toContain("claude -p build");
    expect(out).toContain("codex run");
  });

  it("uses singular wording for a single command / job / attempt", () => {
    const out = renderBusiest(summarizeBusiest([job({ command: ["x"], attempts: 1 })]), { now: NOW });
    expect(out).toContain("1 command");
    expect(out).not.toContain("1 commands");
    expect(out).toContain("across 1 job");
    expect(out).toContain("1 resume attempt");
    expect(out).not.toContain("1 resume attempts");
  });

  it("shows a live countdown for the soonest reset among a command's waiting jobs", () => {
    const resetAt = new Date(NOW + 63 * 60_000).toISOString(); // 1h 3m out
    const out = renderBusiest(summarizeBusiest([job({ status: "waiting_for_reset", resetAt })]), { now: NOW });
    expect(out).toContain(resetAt);
    expect(out).toContain("in 1h 3m");
  });

  it("marks an all-terminal command as idle and an active-but-unwaiting one with a dash", () => {
    const idle = renderBusiest(summarizeBusiest([job({ command: ["done"], status: "completed" })]), { now: NOW });
    expect(idle).toContain("(idle)");
    const active = renderBusiest(summarizeBusiest([job({ command: ["run"], status: "resuming" })]), { now: NOW });
    expect(active).toContain("—");
  });

  it("caps the table at --limit and notes how many were hidden", () => {
    const jobs = ["a", "b", "c", "d"].map((c, i) => job({ command: [c], attempts: 10 - i }));
    const out = renderBusiest(summarizeBusiest(jobs), { now: NOW, limit: 2 });
    expect(out).toContain("  a  ");
    expect(out).toContain("  b  ");
    expect(out).not.toMatch(/\n {2}c {2}/);
    expect(out).toContain("…and 2 more");
  });

  it("shows every command when limit is 0", () => {
    const jobs = ["a", "b", "c"].map((c) => job({ command: [c] }));
    const out = renderBusiest(summarizeBusiest(jobs), { now: NOW, limit: 0 });
    expect(out).not.toContain("more");
    for (const c of ["a", "b", "c"]) expect(out).toContain(`  ${c}  `);
  });

  it("emits ANSI color only when color is enabled", () => {
    const s = summarizeBusiest([job()]);
    expect(renderBusiest(s, { now: NOW, color: false })).not.toContain("\x1b[");
    expect(renderBusiest(s, { now: NOW, color: true })).toContain("\x1b[");
  });
});

describe("renderBusiestJson", () => {
  it("carries the full summary plus provenance and is unaffected by the table limit", () => {
    const summary = summarizeBusiest([
      job({ command: ["a"], attempts: 5 }),
      job({ command: ["b"], attempts: 3 }),
      job({ command: ["c"], attempts: 1 }),
    ]);
    const parsed = JSON.parse(
      renderBusiestJson({
        storePath: "/x/jobs.json",
        generatedAt: "2026-08-10T12:00:00.000Z",
        scope: { status: ["failed"] },
        summary,
      })
    );
    expect(parsed.storePath).toBe("/x/jobs.json");
    expect(parsed.generatedAt).toBe("2026-08-10T12:00:00.000Z");
    expect(parsed.scope).toEqual({ status: ["failed"] });
    expect(parsed.summary.commandCount).toBe(3);
    expect(parsed.summary.totalAttempts).toBe(9);
    expect(parsed.summary.commands.map((c: { display: string }) => c.display)).toEqual(["a", "b", "c"]);
  });
});
