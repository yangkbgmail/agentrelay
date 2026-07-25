import type { RelayJob, UpcomingResumes } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_PENDING_MESSAGE, renderUpcoming, renderUpcomingJson } from "../src/upcoming.js";

const NOW = Date.parse("2026-07-13T00:00:00.000Z");

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
    resetAt: at(90 * 60_000),
    createdAt: at(-1000),
    updatedAt: at(-1000),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function result(overrides: Partial<UpcomingResumes> = {}): UpcomingResumes {
  return {
    entries: [{ job: job(), dueInMs: 90 * 60_000, due: false }],
    totalWaiting: 1,
    hidden: 0,
    ...overrides,
  };
}

describe("renderUpcoming", () => {
  it("shows the empty message when nothing is waiting", () => {
    const out = renderUpcoming(result({ entries: [], totalWaiting: 0, hidden: 0 }), { now: NOW });
    expect(out).toBe(NO_PENDING_MESSAGE);
  });

  it("lists id, project, countdown and absolute reset time per entry", () => {
    const out = renderUpcoming(result(), { now: NOW });
    expect(out).toContain("abcdef12");
    expect(out).toContain("demo");
    expect(out).toContain("resets in 1h 30m");
    expect(out).toContain(at(90 * 60_000));
  });

  it("renders one line per entry in the given order", () => {
    const out = renderUpcoming(
      result({
        entries: [
          { job: job({ id: "first000", resetAt: at(1000) }), dueInMs: 1000, due: false },
          { job: job({ id: "second00", resetAt: at(2000) }), dueInMs: 2000, due: false },
        ],
        totalWaiting: 2,
      }),
      { now: NOW }
    );
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("first000");
    expect(lines[1]).toContain("second00");
  });

  it("says 'due now' for a passed reset", () => {
    const out = renderUpcoming(result({ entries: [{ job: job({ resetAt: at(-1000) }), dueInMs: -1000, due: true }] }), {
      now: NOW,
    });
    expect(out).toContain("due now");
    expect(out).not.toContain("resets in");
  });

  it("adds a footer with the hidden remainder (singular/plural)", () => {
    expect(renderUpcoming(result({ hidden: 1, totalWaiting: 2 }), { now: NOW })).toContain("1 more job waiting");
    expect(renderUpcoming(result({ hidden: 3, totalWaiting: 4 }), { now: NOW })).toContain("3 more jobs waiting");
  });

  it("omits the footer when nothing is hidden", () => {
    expect(renderUpcoming(result({ hidden: 0 }), { now: NOW })).not.toContain("more job");
  });

  it("prints a scope header when a scope note is given", () => {
    expect(renderUpcoming(result(), { now: NOW, scopeNote: "project=demo" })).toContain("scope: project=demo");
  });

  it("still prints the scope header when nothing matches", () => {
    const out = renderUpcoming(result({ entries: [], totalWaiting: 0 }), { now: NOW, scopeNote: "tool=codex-cli" });
    expect(out).toContain("scope: tool=codex-cli");
    expect(out).toContain(NO_PENDING_MESSAGE);
  });

  it("emits no ANSI codes when color is off", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderUpcoming(result({ hidden: 2 }), { now: NOW, color: false })).not.toMatch(/\x1b\[/);
  });
});

describe("renderUpcomingJson", () => {
  it("produces valid JSON with storePath, counts and an empty timeline when idle", () => {
    const parsed = JSON.parse(
      renderUpcomingJson(result({ entries: [], totalWaiting: 0 }), "/tmp/store.json", {
        generatedAt: "2026-07-13T00:00:00.000Z",
      })
    );
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-13T00:00:00.000Z");
    expect(parsed.totalWaiting).toBe(0);
    expect(parsed.upcoming).toEqual([]);
  });

  it("carries each entry plus its derived due state and counts", () => {
    const parsed = JSON.parse(
      renderUpcomingJson(result({ hidden: 2, totalWaiting: 3 }), "/tmp/store.json", { scopeNote: "project=demo" })
    );
    expect(parsed.upcoming[0].job.project).toBe("demo");
    expect(parsed.upcoming[0].due).toBe(false);
    expect(parsed.hidden).toBe(2);
    expect(parsed.totalWaiting).toBe(3);
    expect(parsed.scope).toBe("project=demo");
  });
});
