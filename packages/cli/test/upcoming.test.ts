import { buildUpcomingTimeline, type RelayJob, type UpcomingTimeline } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_UPCOMING_MESSAGE, renderUpcoming, renderUpcomingJson, renderUpcomingWatchFrame } from "../src/upcoming.js";

const NOW = Date.parse("2026-07-30T10:00:00.000Z");

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

function timeline(jobs: RelayJob[], limit?: number): UpcomingTimeline {
  return buildUpcomingTimeline(jobs, NOW, limit);
}

describe("renderUpcoming", () => {
  it("shows the empty message when nothing is waiting", () => {
    expect(renderUpcoming(timeline([]), { now: NOW })).toBe(NO_UPCOMING_MESSAGE);
  });

  it("appends the scope note to the empty message when scoped", () => {
    const out = renderUpcoming(timeline([]), { now: NOW, scopeNote: "project=ghost" });
    expect(out).toContain(NO_UPCOMING_MESSAGE);
    expect(out).toContain("scope: project=ghost");
  });

  it("renders one row per waiting job in resume order with positions", () => {
    const out = renderUpcoming(
      timeline([
        job({ id: "late0000", project: "late-app", resetAt: at(5 * 3_600_000) }),
        job({ id: "soon0000", project: "soon-app", resetAt: at(60 * 60_000) }),
      ]),
      { now: NOW }
    );
    const lines = out.split("\n");
    // Header, then soon before late.
    expect(lines[0]).toContain("PROJECT");
    expect(out.indexOf("soon-app")).toBeLessThan(out.indexOf("late-app"));
    expect(out).toContain("1  ");
    expect(out).toContain("2  ");
  });

  it("shows 'due now' for a job whose reset has passed", () => {
    const out = renderUpcoming(timeline([job({ resetAt: at(-60_000) })]), { now: NOW });
    expect(out).toContain("due now");
  });

  it("reuses the shared countdown format for future resets", () => {
    const out = renderUpcoming(timeline([job({ resetAt: at(90 * 60_000) })]), { now: NOW });
    expect(out).toContain("1h 30m");
  });

  it("footer reports totals, due-now count, and hidden rows under a limit", () => {
    const jobs = [
      job({ id: "j1", resetAt: at(-60_000) }),
      job({ id: "j2", resetAt: at(60 * 60_000) }),
      job({ id: "j3", resetAt: at(120 * 60_000) }),
    ];
    const out = renderUpcoming(timeline(jobs, 1), { now: NOW });
    expect(out).toContain("3 jobs waiting");
    expect(out).toContain("1 due now");
    expect(out).toContain("2 more not shown");
  });

  it("does not emit ANSI escapes when color is off", () => {
    const out = renderUpcoming(timeline([job()]), { now: NOW, color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no escapes.
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe("renderUpcomingJson", () => {
  it("emits the store path, timeline, and honest totals", () => {
    const t = timeline([job({ id: "j1", resetAt: at(60 * 60_000) })], 1);
    const parsed = JSON.parse(
      renderUpcomingJson({ storePath: "/tmp/jobs.json", generatedAt: "2026-07-30T10:00:00.000Z", timeline: t })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.timeline.entries).toHaveLength(1);
    expect(parsed.timeline.entries[0].job.id).toBe("j1");
    expect(parsed.timeline.totalWaiting).toBe(1);
  });

  it("includes the scope when one is passed", () => {
    const parsed = JSON.parse(
      renderUpcomingJson({
        storePath: "/tmp/jobs.json",
        scope: { projects: ["demo"] },
        timeline: timeline([]),
      })
    );
    expect(parsed.scope).toEqual({ projects: ["demo"] });
  });
});

describe("renderUpcomingWatchFrame", () => {
  it("includes the live title, store path, timestamp and the timeline", () => {
    const frame = renderUpcomingWatchFrame(
      timeline([job({ id: "abcdef1234567890", project: "demo" })]),
      "/tmp/store.json",
      2000,
      { now: NOW }
    );
    expect(frame).toContain("agentrelay upcoming");
    expect(frame).toContain("every 2s");
    expect(frame).toContain("/tmp/store.json");
    expect(frame).toContain("2026-07-30 10:00:00");
    expect(frame).toContain("abcdef12"); // short id row from the timeline
  });

  it("passes the scope note through to the underlying table", () => {
    const frame = renderUpcomingWatchFrame(timeline([]), "/tmp/store.json", 5000, {
      now: NOW,
      scopeNote: "project=ghost",
    });
    expect(frame).toContain("every 5s");
    expect(frame).toContain("scope: project=ghost");
  });
});
