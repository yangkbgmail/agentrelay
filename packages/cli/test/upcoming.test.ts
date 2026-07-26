import type { RelayJob, UpcomingResumes } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_PENDING_MESSAGE } from "../src/next.js";
import { renderUpcoming, renderUpcomingJson } from "../src/upcoming.js";

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

function timeline(overrides: Partial<UpcomingResumes> = {}): UpcomingResumes {
  return {
    entries: [
      { job: job({ id: "aaaa1111", project: "alpha", resetAt: at(-60_000) }), dueInMs: -60_000, due: true },
      { job: job({ id: "bbbb2222", project: "beta", resetAt: at(90 * 60_000) }), dueInMs: 90 * 60_000, due: false },
    ],
    totalWaiting: 2,
    dueNow: 1,
    ...overrides,
  };
}

describe("renderUpcoming", () => {
  it("shows the empty message when nothing is waiting", () => {
    const empty: UpcomingResumes = { entries: [], totalWaiting: 0, dueNow: 0 };
    expect(renderUpcoming(empty, { now: NOW })).toBe(NO_PENDING_MESSAGE);
  });

  it("renders a header with the waiting count and the due-now note", () => {
    const out = renderUpcoming(timeline(), { now: NOW });
    expect(out).toContain("Upcoming resumes");
    expect(out).toContain("2 jobs waiting");
    expect(out).toContain("1 due now");
  });

  it("uses singular 'job' and omits the due note when nothing is due", () => {
    const one = timeline({
      entries: [{ job: job({ id: "cccc3333", resetAt: at(60 * 60_000) }), dueInMs: 60 * 60_000, due: false }],
      totalWaiting: 1,
      dueNow: 0,
    });
    const out = renderUpcoming(one, { now: NOW });
    expect(out).toContain("1 job waiting");
    expect(out).not.toContain("due now");
  });

  it("shows each row's short id, project, countdown and absolute reset time", () => {
    const out = renderUpcoming(timeline(), { now: NOW });
    expect(out).toContain("aaaa1111");
    expect(out).toContain("alpha");
    expect(out).toContain("bbbb2222");
    expect(out).toContain("beta");
    expect(out).toContain("in 1h 30m");
    expect(out).toContain(at(90 * 60_000));
  });

  it("marks due rows 'due now' rather than a countdown", () => {
    const out = renderUpcoming(timeline(), { now: NOW });
    expect(out).toContain("due now");
  });

  it("adds a 'more not shown' footer when the view is truncated", () => {
    const truncated = timeline({
      entries: [{ job: job({ id: "aaaa1111", resetAt: at(-60_000) }), dueInMs: -60_000, due: true }],
      totalWaiting: 4,
      dueNow: 1,
    });
    const out = renderUpcoming(truncated, { now: NOW });
    expect(out).toContain("… 3 more jobs not shown");
  });

  it("uses singular in the footer when exactly one is hidden", () => {
    const truncated = timeline({
      entries: [{ job: job({ id: "aaaa1111", resetAt: at(-60_000) }), dueInMs: -60_000, due: true }],
      totalWaiting: 2,
      dueNow: 1,
    });
    expect(renderUpcoming(truncated, { now: NOW })).toContain("… 1 more job not shown");
  });

  it("emits no ANSI codes when color is off", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderUpcoming(timeline(), { now: NOW, color: false })).not.toMatch(/\x1b\[/);
  });
});

describe("renderUpcomingJson", () => {
  it("produces valid JSON with storePath and the full timeline", () => {
    const parsed = JSON.parse(renderUpcomingJson(timeline(), "/tmp/store.json", "2026-07-13T00:00:00.000Z"));
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-13T00:00:00.000Z");
    expect(parsed.upcoming.totalWaiting).toBe(2);
    expect(parsed.upcoming.dueNow).toBe(1);
    expect(parsed.upcoming.entries).toHaveLength(2);
    expect(parsed.upcoming.entries[0].job.project).toBe("alpha");
    expect(parsed.upcoming.entries[0].due).toBe(true);
  });
});
