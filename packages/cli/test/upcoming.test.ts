import type { RelayJob, UpcomingResume } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  NO_UPCOMING_IN_WINDOW_MESSAGE,
  NO_UPCOMING_MESSAGE,
  renderUpcoming,
  renderUpcomingJson,
} from "../src/upcoming.js";

const NOW = Date.parse("2026-07-24T12:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `abcdef${seq}234567890`,
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

function entry(overrides: Partial<UpcomingResume> = {}): UpcomingResume {
  return {
    job: job(),
    dueInMs: 90 * 60_000,
    due: false,
    ...overrides,
  };
}

describe("renderUpcoming", () => {
  it("shows the empty message when nothing is waiting", () => {
    expect(renderUpcoming([], { now: NOW })).toBe(NO_UPCOMING_MESSAGE);
  });

  it("shows the windowed empty message when a window filtered everything out", () => {
    expect(renderUpcoming([], { now: NOW, windowed: true })).toBe(NO_UPCOMING_IN_WINDOW_MESSAGE);
  });

  it("renders one line per entry with short id, project, countdown, absolute reset", () => {
    const out = renderUpcoming([entry({ job: job({ resetAt: at(90 * 60_000) }) })], { now: NOW });
    expect(out).toContain("abcdef");
    expect(out).toContain("demo");
    expect(out).toContain("in 1h 30m");
    expect(out).toContain(at(90 * 60_000));
  });

  it("says 'due now' for already-due entries", () => {
    const out = renderUpcoming([entry({ job: job({ resetAt: at(-1000) }), dueInMs: -1000, due: true })], { now: NOW });
    expect(out).toContain("due now");
    expect(out).not.toContain("in ");
  });

  it("renders entries in the order given (soonest-first is the caller's job)", () => {
    const a = entry({ job: job({ project: "first", resetAt: at(10 * 60_000) }), dueInMs: 10 * 60_000 });
    const b = entry({ job: job({ project: "second", resetAt: at(30 * 60_000) }), dueInMs: 30 * 60_000 });
    const lines = renderUpcoming([a, b], { now: NOW }).split("\n");
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("second");
  });

  it("adds a hidden-count footer with singular/plural when --limit trims", () => {
    const one = renderUpcoming([entry()], { now: NOW, hiddenByLimit: 1 });
    expect(one).toContain("1 more job not shown");
    const many = renderUpcoming([entry()], { now: NOW, hiddenByLimit: 3 });
    expect(many).toContain("3 more jobs not shown");
  });

  it("omits the footer when nothing is hidden", () => {
    expect(renderUpcoming([entry()], { now: NOW, hiddenByLimit: 0 })).not.toContain("not shown");
  });

  it("emits no ANSI codes when color is off", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderUpcoming([entry()], { now: NOW, color: false, hiddenByLimit: 2 })).not.toMatch(/\x1b\[/);
  });
});

describe("renderUpcomingJson", () => {
  it("produces valid JSON with storePath, count and an empty timeline when idle", () => {
    const parsed = JSON.parse(renderUpcomingJson([], "/tmp/store.json", "2026-07-24T12:00:00.000Z"));
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-24T12:00:00.000Z");
    expect(parsed.count).toBe(0);
    expect(parsed.upcoming).toEqual([]);
  });

  it("carries every entry with its full job and derived due state", () => {
    const parsed = JSON.parse(renderUpcomingJson([entry({ due: true, dueInMs: -500 }), entry()], "/tmp/store.json"));
    expect(parsed.count).toBe(2);
    expect(parsed.upcoming[0].job.project).toBe("demo");
    expect(parsed.upcoming[0].due).toBe(true);
    expect(parsed.upcoming[0].dueInMs).toBe(-500);
  });
});
