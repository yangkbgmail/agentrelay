import type { RelayJob, UpcomingResume, UpcomingResumes } from "@agentrelay/core";
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

function entry(overrides: Partial<UpcomingResume> = {}): UpcomingResume {
  return {
    job: job(),
    dueInMs: 90 * 60_000,
    due: false,
    position: 1,
    ...overrides,
  };
}

function upcoming(entries: UpcomingResume[], overrides: Partial<UpcomingResumes> = {}): UpcomingResumes {
  return {
    entries,
    totalWaiting: entries.length,
    truncated: false,
    ...overrides,
  };
}

describe("renderUpcoming", () => {
  it("shows the empty message when nothing is waiting", () => {
    expect(renderUpcoming(upcoming([]), { now: NOW })).toBe(NO_UPCOMING_MESSAGE);
  });

  it("renders a header and one row per entry with position, id, project and countdown", () => {
    const out = renderUpcoming(
      upcoming([
        entry({ position: 1, job: job({ id: "aaaaaaaa1111", project: "alpha", resetAt: at(30 * 60_000) }) }),
        entry({ position: 2, job: job({ id: "bbbbbbbb2222", project: "beta", resetAt: at(2 * 3600_000) }) }),
      ]),
      { now: NOW }
    );
    expect(out).toContain("#");
    expect(out).toContain("PROJECT");
    expect(out).toContain("RESETS IN");
    expect(out).toContain("aaaaaaaa");
    expect(out).toContain("alpha");
    expect(out).toContain("30m");
    expect(out).toContain("bbbbbbbb");
    expect(out).toContain("beta");
    expect(out).toContain("2h 0m");
    // Two data rows plus a header line.
    expect(out.split("\n")).toHaveLength(3);
  });

  it("says 'due now' for entries whose reset has passed", () => {
    const out = renderUpcoming(upcoming([entry({ due: true, dueInMs: -1000, job: job({ resetAt: at(-1000) }) })]), {
      now: NOW,
    });
    expect(out).toContain("due now");
  });

  it("adds a footer noting hidden jobs when truncated (plural)", () => {
    const out = renderUpcoming(upcoming([entry()], { totalWaiting: 4, truncated: true }), { now: NOW });
    expect(out).toContain("3 more waiting jobs not shown.");
  });

  it("uses the singular in the truncation footer when exactly one is hidden", () => {
    const out = renderUpcoming(upcoming([entry()], { totalWaiting: 2, truncated: true }), { now: NOW });
    expect(out).toContain("1 more waiting job not shown.");
  });

  it("omits the footer when not truncated", () => {
    const out = renderUpcoming(upcoming([entry()]), { now: NOW });
    expect(out).not.toContain("not shown");
  });

  it("emits no ANSI codes when color is off", () => {
    const out = renderUpcoming(upcoming([entry()], { totalWaiting: 3, truncated: true }), { now: NOW, color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe("renderUpcomingJson", () => {
  it("produces valid JSON with storePath, timestamp and the full schedule", () => {
    const parsed = JSON.parse(
      renderUpcomingJson(upcoming([entry()], { totalWaiting: 1 }), "/tmp/store.json", "2026-07-13T00:00:00.000Z")
    );
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-13T00:00:00.000Z");
    expect(parsed.totalWaiting).toBe(1);
    expect(parsed.truncated).toBe(false);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].position).toBe(1);
    expect(parsed.entries[0].job.project).toBe("demo");
  });
});
