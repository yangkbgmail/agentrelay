import type { RelayJob, UpcomingSchedule } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_UPCOMING_MESSAGE, renderUpcoming, renderUpcomingJson } from "../src/upcoming.js";

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

function schedule(overrides: Partial<UpcomingSchedule> = {}): UpcomingSchedule {
  return {
    resumes: [{ job: job(), dueInMs: 90 * 60_000, due: false }],
    totalWaiting: 1,
    dueNow: 0,
    hidden: 0,
    ...overrides,
  };
}

describe("renderUpcoming", () => {
  it("shows the empty message when nothing is waiting", () => {
    expect(renderUpcoming(schedule({ resumes: [], totalWaiting: 0 }), { now: NOW })).toBe(NO_UPCOMING_MESSAGE);
  });

  it("lists each resume with short id, project, countdown and absolute reset time", () => {
    const out = renderUpcoming(schedule(), { now: NOW });
    expect(out).toContain("Upcoming resumes (1 job waiting)");
    expect(out).toContain("abcdef12");
    expect(out).toContain("demo");
    expect(out).toContain("resets in 1h 30m");
    expect(out).toContain(at(90 * 60_000));
  });

  it("numbers resumes in order", () => {
    const out = renderUpcoming(
      schedule({
        resumes: [
          { job: job({ id: "aaaaaaaa1", project: "one" }), dueInMs: 60_000, due: false },
          { job: job({ id: "bbbbbbbb2", project: "two" }), dueInMs: 120_000, due: false },
        ],
        totalWaiting: 2,
      }),
      { now: NOW }
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("2 jobs waiting");
    expect(lines[1]).toContain("1.");
    expect(lines[1]).toContain("one");
    expect(lines[2]).toContain("2.");
    expect(lines[2]).toContain("two");
  });

  it("says 'due now' for a resume whose reset has passed", () => {
    const out = renderUpcoming(
      schedule({ resumes: [{ job: job({ resetAt: at(-1000) }), dueInMs: -1000, due: true }], dueNow: 1 }),
      { now: NOW }
    );
    expect(out).toContain("due now");
  });

  it("footer reports the due-now count", () => {
    const out = renderUpcoming(schedule({ totalWaiting: 3, dueNow: 2 }), { now: NOW });
    expect(out).toContain("2 due now");
  });

  it("footer reports the hidden count with singular/plural", () => {
    expect(renderUpcoming(schedule({ totalWaiting: 2, hidden: 1 }), { now: NOW })).toContain("1 more job not shown");
    expect(renderUpcoming(schedule({ totalWaiting: 5, hidden: 3 }), { now: NOW })).toContain("3 more jobs not shown");
  });

  it("emits no ANSI codes when color is off", () => {
    const out = renderUpcoming(schedule({ totalWaiting: 4, dueNow: 1, hidden: 1 }), { now: NOW, color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe("renderUpcomingJson", () => {
  it("produces valid JSON with storePath and an empty schedule when idle", () => {
    const parsed = JSON.parse(
      renderUpcomingJson(schedule({ resumes: [], totalWaiting: 0 }), "/tmp/store.json", "2026-07-13T00:00:00.000Z")
    );
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-13T00:00:00.000Z");
    expect(parsed.resumes).toEqual([]);
    expect(parsed.totalWaiting).toBe(0);
  });

  it("carries the resumes plus totals", () => {
    const parsed = JSON.parse(
      renderUpcomingJson(schedule({ totalWaiting: 3, dueNow: 1, hidden: 2 }), "/tmp/store.json")
    );
    expect(parsed.resumes[0].job.project).toBe("demo");
    expect(parsed.resumes[0].due).toBe(false);
    expect(parsed.totalWaiting).toBe(3);
    expect(parsed.dueNow).toBe(1);
    expect(parsed.hidden).toBe(2);
  });
});
