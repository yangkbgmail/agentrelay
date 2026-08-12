import { describe, expect, it } from "vitest";
import { formatCommand, summarizeBusiest } from "./busiest.js";
import type { RelayJob } from "./types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("formatCommand", () => {
  it("joins plain tokens with a space", () => {
    expect(formatCommand(["claude", "-p", "go"])).toBe("claude -p go");
  });

  it("quotes tokens with whitespace and escapes embedded quotes/backslashes", () => {
    expect(formatCommand(["claude", "-p", "do the thing"])).toBe('claude -p "do the thing"');
    expect(formatCommand(["echo", 'a"b'])).toBe('echo "a\\"b"');
    expect(formatCommand(["path", "C:\\a b"])).toBe('path "C:\\\\a b"');
  });

  it("renders empty tokens and an empty argv as visible, distinct keys", () => {
    expect(formatCommand(["claude", ""])).toBe('claude ""');
    expect(formatCommand([])).toBe('""');
  });
});

describe("summarizeBusiest", () => {
  it("returns an empty shape for no jobs", () => {
    expect(summarizeBusiest([])).toEqual({ total: 0, commandCount: 0, totalAttempts: 0, commands: [] });
  });

  it("groups jobs by exact command across projects/cwds and sums attempts", () => {
    const summary = summarizeBusiest([
      job({ command: ["claude", "-p", "build"], project: "web", cwd: "/a", attempts: 3, status: "completed" }),
      job({ command: ["claude", "-p", "build"], project: "api", cwd: "/b", attempts: 2, status: "queued" }),
      job({ command: ["codex", "run"], attempts: 1, status: "failed" }),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.commandCount).toBe(2);
    expect(summary.totalAttempts).toBe(6);

    const build = summary.commands.find((c) => c.display === "claude -p build");
    expect(build).toMatchObject({ total: 2, active: 1, terminal: 1, waiting: 0, attempts: 5 });
  });

  it("keeps commands that differ only by a flag distinct", () => {
    const summary = summarizeBusiest([job({ command: ["claude", "-p"] }), job({ command: ["claude", "-P"] })]);
    expect(summary.commandCount).toBe(2);
  });

  it("classifies each status as active or terminal and counts waiting", () => {
    const summary = summarizeBusiest([
      job({ status: "queued" }),
      job({ status: "waiting_for_reset" }),
      job({ status: "resuming" }),
      job({ status: "completed" }),
      job({ status: "failed" }),
      job({ status: "cancelled" }),
    ]);
    const row = summary.commands[0];
    expect(row.total).toBe(6);
    expect(row.active).toBe(3);
    expect(row.terminal).toBe(3);
    expect(row.waiting).toBe(1);
  });

  it("picks the earliest resetAt among waiting jobs only", () => {
    const summary = summarizeBusiest([
      job({ status: "waiting_for_reset", resetAt: "2026-07-13T18:00:00.000Z" }),
      job({ status: "waiting_for_reset", resetAt: "2026-07-13T15:00:00.000Z" }),
      job({ status: "resuming", resetAt: "2026-07-13T09:00:00.000Z" }),
    ]);
    expect(summary.commands[0].nextResetAt).toBe("2026-07-13T15:00:00.000Z");
  });

  it("tracks the most recent updatedAt as lastActivityAt", () => {
    const summary = summarizeBusiest([
      job({ updatedAt: "2026-07-13T01:00:00.000Z" }),
      job({ updatedAt: "2026-07-13T05:00:00.000Z" }),
      job({ updatedAt: "2026-07-13T03:00:00.000Z" }),
    ]);
    expect(summary.commands[0].lastActivityAt).toBe("2026-07-13T05:00:00.000Z");
  });

  it("ignores non-positive/non-finite attempts when summing effort", () => {
    const summary = summarizeBusiest([
      job({ command: ["x"], attempts: 0 }),
      job({ command: ["x"], attempts: -4 }),
      job({ command: ["x"], attempts: Number.NaN }),
      job({ command: ["x"], attempts: 2 }),
    ]);
    expect(summary.commands[0].attempts).toBe(2);
    expect(summary.totalAttempts).toBe(2);
  });

  it("ranks by attempts desc, then total desc, then active desc, then display asc", () => {
    const summary = summarizeBusiest([
      // "big": attempts 10, total 1
      job({ command: ["big"], attempts: 10 }),
      // "mid": attempts 5, total 3
      job({ command: ["mid"], attempts: 2 }),
      job({ command: ["mid"], attempts: 2 }),
      job({ command: ["mid"], attempts: 1 }),
      // "aaa" vs "zzz": both attempts 1, total 1 → tie broken by active then display
      job({ command: ["zzz"], attempts: 1, status: "queued" }),
      job({ command: ["aaa"], attempts: 1, status: "completed" }),
    ]);
    expect(summary.commands.map((c) => c.display)).toEqual(["big", "mid", "zzz", "aaa"]);
  });
});
