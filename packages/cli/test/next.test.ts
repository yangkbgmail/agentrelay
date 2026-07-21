import type { NextResume, RelayJob, UpcomingResumes } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_PENDING_MESSAGE, renderNext, renderNextJson, renderUpcoming, renderUpcomingJson } from "../src/next.js";

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

function next(overrides: Partial<NextResume> = {}): NextResume {
  return {
    job: job(),
    dueInMs: 90 * 60_000,
    due: false,
    waitingBehind: 0,
    ...overrides,
  };
}

describe("renderNext", () => {
  it("shows the empty message when nothing is waiting", () => {
    expect(renderNext(null, { now: NOW })).toBe(NO_PENDING_MESSAGE);
  });

  it("shows the short id, project, countdown and absolute reset time", () => {
    const out = renderNext(next(), { now: NOW });
    expect(out).toContain("abcdef12");
    expect(out).toContain("demo");
    expect(out).toContain("resets in 1h 30m");
    expect(out).toContain(at(90 * 60_000));
  });

  it("says 'due now' once the reset time has passed", () => {
    const out = renderNext(next({ job: job({ resetAt: at(-1000) }), dueInMs: -1000, due: true }), { now: NOW });
    expect(out).toContain("due now");
    expect(out).not.toContain("resets in");
  });

  it("omits the 'more waiting' note when nothing is behind it", () => {
    expect(renderNext(next({ waitingBehind: 0 }), { now: NOW })).not.toContain("waiting behind");
  });

  it("uses singular/plural for the jobs waiting behind it", () => {
    expect(renderNext(next({ waitingBehind: 1 }), { now: NOW })).toContain("1 more job waiting behind it.");
    expect(renderNext(next({ waitingBehind: 3 }), { now: NOW })).toContain("3 more jobs waiting behind it.");
  });

  it("emits no ANSI codes when color is off", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderNext(next({ waitingBehind: 2 }), { now: NOW, color: false })).not.toMatch(/\x1b\[/);
  });
});

describe("renderNextJson", () => {
  it("produces valid JSON with storePath and a null next when idle", () => {
    const parsed = JSON.parse(renderNextJson(null, "/tmp/store.json", "2026-07-13T00:00:00.000Z"));
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-13T00:00:00.000Z");
    expect(parsed.next).toBeNull();
  });

  it("carries the full job plus derived due state", () => {
    const parsed = JSON.parse(renderNextJson(next({ due: true, dueInMs: -500 }), "/tmp/store.json"));
    expect(parsed.next.job.project).toBe("demo");
    expect(parsed.next.due).toBe(true);
    expect(parsed.next.dueInMs).toBe(-500);
    expect(parsed.next.waitingBehind).toBe(0);
  });
});

function upcoming(overrides: Partial<UpcomingResumes> = {}): UpcomingResumes {
  return {
    entries: [
      { job: job({ id: "aaaaaaaa1111", project: "one", resetAt: at(30 * 60_000) }), dueInMs: 30 * 60_000, due: false },
      { job: job({ id: "bbbbbbbb2222", project: "two", resetAt: at(90 * 60_000) }), dueInMs: 90 * 60_000, due: false },
    ],
    totalWaiting: 2,
    more: 0,
    ...overrides,
  };
}

describe("renderUpcoming", () => {
  it("shows the empty message when nothing is waiting", () => {
    expect(renderUpcoming({ entries: [], totalWaiting: 0, more: 0 }, { now: NOW })).toBe(NO_PENDING_MESSAGE);
  });

  it("renders one line per upcoming resume with id, project and countdown", () => {
    const out = renderUpcoming(upcoming(), { now: NOW });
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("aaaaaaaa");
    expect(lines[0]).toContain("one");
    expect(lines[0]).toContain("resets in 30m");
    expect(lines[1]).toContain("bbbbbbbb");
    expect(lines[1]).toContain("resets in 1h 30m");
  });

  it("says 'due now' for a passed reset time", () => {
    const out = renderUpcoming(
      upcoming({
        entries: [{ job: job({ resetAt: at(-1000) }), dueInMs: -1000, due: true }],
        totalWaiting: 1,
      }),
      { now: NOW }
    );
    expect(out).toContain("due now");
    expect(out).not.toContain("resets in");
  });

  it("appends a dimmed 'more waiting' footer only when jobs are hidden", () => {
    expect(renderUpcoming(upcoming({ more: 0 }), { now: NOW })).not.toContain("waiting behind");
    const one = renderUpcoming(upcoming({ totalWaiting: 3, more: 1 }), { now: NOW });
    expect(one).toContain("1 more job waiting behind them.");
    const many = renderUpcoming(upcoming({ totalWaiting: 5, more: 3 }), { now: NOW });
    expect(many).toContain("3 more jobs waiting behind them.");
  });

  it("emits no ANSI codes when color is off", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderUpcoming(upcoming({ more: 2 }), { now: NOW, color: false })).not.toMatch(/\x1b\[/);
  });
});

describe("renderUpcomingJson", () => {
  it("carries the ordered entries, total and remainder", () => {
    const parsed = JSON.parse(renderUpcomingJson(upcoming({ totalWaiting: 5, more: 3 }), "/tmp/store.json", "T"));
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("T");
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].job.project).toBe("one");
    expect(parsed.totalWaiting).toBe(5);
    expect(parsed.more).toBe(3);
  });
});
