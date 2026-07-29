import type { RelayJob, UpcomingResume, UpcomingResumes } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_UPCOMING_MESSAGE, renderUpcoming, renderUpcomingJson } from "../src/upcoming.js";

const NOW = Date.parse("2026-07-13T00:00:00.000Z");

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
    resetAt: at(60 * 60_000),
    createdAt: at(-1000),
    updatedAt: at(-1000),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function entry(overrides: Partial<UpcomingResume> = {}): UpcomingResume {
  const j = overrides.job ?? job();
  const resetAtMs = Date.parse(j.resetAt as string);
  return {
    job: j,
    resetAtMs,
    dueInMs: resetAtMs - NOW,
    due: resetAtMs <= NOW,
    gapFromPreviousMs: 0,
    ...overrides,
  };
}

function result(entries: UpcomingResume[], overrides: Partial<UpcomingResumes> = {}): UpcomingResumes {
  const spanMs = entries.length >= 2 ? entries[entries.length - 1].resetAtMs - entries[0].resetAtMs : null;
  return {
    entries,
    totalWaiting: entries.length,
    shown: entries.length,
    spanMs,
    ...overrides,
  };
}

describe("renderUpcoming", () => {
  it("shows the empty message when nothing is waiting", () => {
    expect(renderUpcoming(result([]), { now: NOW })).toBe(NO_UPCOMING_MESSAGE);
  });

  it("renders one line per resume with short id, project, countdown and reset time", () => {
    const out = renderUpcoming(result([entry({ job: job({ resetAt: at(90 * 60_000) }) })]), { now: NOW });
    expect(out).toContain("abcdef1");
    expect(out).toContain("demo");
    expect(out).toContain("resets in 1h 30m");
    expect(out).toContain(at(90 * 60_000));
  });

  it("says 'due now' once a reset has passed", () => {
    const out = renderUpcoming(result([entry({ job: job({ resetAt: at(-1000) }), dueInMs: -1000, due: true })]), {
      now: NOW,
    });
    expect(out).toContain("due now");
    expect(out).not.toContain("resets in");
  });

  it("shows the +gap since the previous resume (but not on the first row)", () => {
    const e1 = entry({ job: job({ resetAt: at(30 * 60_000) }), gapFromPreviousMs: 0 });
    const e2 = entry({ job: job({ resetAt: at(90 * 60_000) }), gapFromPreviousMs: 60 * 60_000 });
    const out = renderUpcoming(result([e1, e2]), { now: NOW });
    const lines = out.split("\n");
    expect(lines[0]).not.toContain("+");
    expect(lines[1]).toContain("(+1h 0m)");
  });

  it("omits the gap annotation for a zero gap (same-instant resets)", () => {
    const e1 = entry({ job: job({ resetAt: at(30 * 60_000) }), gapFromPreviousMs: 0 });
    const e2 = entry({ job: job({ resetAt: at(30 * 60_000) }), gapFromPreviousMs: 0 });
    const out = renderUpcoming(result([e1, e2]), { now: NOW });
    expect(out).not.toContain("(+");
  });

  it("footer counts all waiting and notes the span", () => {
    const e1 = entry({ job: job({ resetAt: at(30 * 60_000) }) });
    const e2 = entry({ job: job({ resetAt: at(150 * 60_000) }), gapFromPreviousMs: 120 * 60_000 });
    const out = renderUpcoming(result([e1, e2]), { now: NOW });
    expect(out).toContain("2 jobs waiting for a reset");
    expect(out).toContain("timeline spans 2h 0m");
  });

  it("footer distinguishes a limited view from the full set", () => {
    const e1 = entry({ job: job({ resetAt: at(10 * 60_000) }) });
    const e2 = entry({ job: job({ resetAt: at(20 * 60_000) }), gapFromPreviousMs: 10 * 60_000 });
    const out = renderUpcoming(result([e1, e2], { totalWaiting: 5, shown: 2 }), { now: NOW });
    expect(out).toContain("2 of 5 waiting jobs shown");
  });

  it("emits no ANSI codes when color is off", () => {
    const e1 = entry({ job: job({ resetAt: at(30 * 60_000) }) });
    const e2 = entry({ job: job({ resetAt: at(90 * 60_000) }), gapFromPreviousMs: 60 * 60_000, due: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderUpcoming(result([e1, e2]), { now: NOW, color: false })).not.toMatch(/\x1b\[/);
  });
});

describe("renderUpcomingJson", () => {
  it("produces valid JSON with storePath, totals and entries", () => {
    const e1 = entry({ job: job({ resetAt: at(30 * 60_000) }) });
    const parsed = JSON.parse(
      renderUpcomingJson(result([e1], { totalWaiting: 3, shown: 1 }), "/tmp/store.json", "2026-07-13T00:00:00.000Z")
    );
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-13T00:00:00.000Z");
    expect(parsed.totalWaiting).toBe(3);
    expect(parsed.shown).toBe(1);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].job.project).toBe("demo");
  });
});
