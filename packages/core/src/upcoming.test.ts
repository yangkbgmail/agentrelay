import { describe, expect, it } from "vitest";
import type { RelayJob } from "./types.js";
import { buildUpcomingTimeline } from "./upcoming.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "waiting_for_reset",
    resetAt: "2026-07-30T12:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-30T10:00:00.000Z");

describe("buildUpcomingTimeline", () => {
  it("returns an empty timeline when nothing is waiting", () => {
    const timeline = buildUpcomingTimeline([], NOW);
    expect(timeline).toEqual({ entries: [], totalWaiting: 0, hidden: 0, dueNow: 0 });
  });

  it("ignores jobs that are not waiting_for_reset", () => {
    const timeline = buildUpcomingTimeline(
      [job({ status: "completed" }), job({ status: "queued" }), job({ status: "resuming" }), job({ status: "failed" })],
      NOW
    );
    expect(timeline.totalWaiting).toBe(0);
    expect(timeline.entries).toHaveLength(0);
  });

  it("ignores waiting jobs with a missing or unparseable resetAt", () => {
    const timeline = buildUpcomingTimeline(
      [
        job({ id: "no-reset", resetAt: null }),
        job({ id: "bad-reset", resetAt: "not a date" }),
        job({ id: "good", resetAt: "2026-07-30T13:00:00.000Z" }),
      ],
      NOW
    );
    expect(timeline.totalWaiting).toBe(1);
    expect(timeline.entries.map((e) => e.job.id)).toEqual(["good"]);
  });

  it("orders entries by soonest reset and numbers positions from 1", () => {
    const timeline = buildUpcomingTimeline(
      [
        job({ id: "late", resetAt: "2026-07-30T15:00:00.000Z" }),
        job({ id: "soon", resetAt: "2026-07-30T11:00:00.000Z" }),
        job({ id: "mid", resetAt: "2026-07-30T13:00:00.000Z" }),
      ],
      NOW
    );
    expect(timeline.entries.map((e) => e.job.id)).toEqual(["soon", "mid", "late"]);
    expect(timeline.entries.map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it("breaks ties deterministically by createdAt then id, matching next", () => {
    const timeline = buildUpcomingTimeline(
      [
        job({ id: "b", resetAt: "2026-07-30T12:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "a", resetAt: "2026-07-30T12:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "c", resetAt: "2026-07-30T12:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
      ],
      NOW
    );
    // Same reset → oldest createdAt first (c), then id order (a before b).
    expect(timeline.entries.map((e) => e.job.id)).toEqual(["c", "a", "b"]);
  });

  it("computes dueInMs and the due flag against now", () => {
    const timeline = buildUpcomingTimeline(
      [
        job({ id: "past", resetAt: "2026-07-30T09:00:00.000Z" }),
        job({ id: "future", resetAt: "2026-07-30T11:30:00.000Z" }),
      ],
      NOW
    );
    const past = timeline.entries.find((e) => e.job.id === "past");
    const future = timeline.entries.find((e) => e.job.id === "future");
    expect(past?.due).toBe(true);
    expect(past?.dueInMs).toBe(-60 * 60 * 1000);
    expect(future?.due).toBe(false);
    expect(future?.dueInMs).toBe(90 * 60 * 1000);
    expect(timeline.dueNow).toBe(1);
  });

  it("treats a reset exactly at now as due", () => {
    const timeline = buildUpcomingTimeline([job({ resetAt: "2026-07-30T10:00:00.000Z" })], NOW);
    expect(timeline.entries[0]?.due).toBe(true);
    expect(timeline.dueNow).toBe(1);
  });

  it("trims to the limit while keeping totals honest", () => {
    const timeline = buildUpcomingTimeline(
      [
        job({ id: "j1", resetAt: "2026-07-30T11:00:00.000Z" }),
        job({ id: "j2", resetAt: "2026-07-30T12:00:00.000Z" }),
        job({ id: "j3", resetAt: "2026-07-30T13:00:00.000Z" }),
        job({ id: "j4", resetAt: "2026-07-30T14:00:00.000Z" }),
      ],
      NOW,
      2
    );
    expect(timeline.entries.map((e) => e.job.id)).toEqual(["j1", "j2"]);
    expect(timeline.totalWaiting).toBe(4);
    expect(timeline.hidden).toBe(2);
  });

  it("ignores a non-positive or non-integer limit and shows everything", () => {
    const jobs = [
      job({ id: "j1", resetAt: "2026-07-30T11:00:00.000Z" }),
      job({ id: "j2", resetAt: "2026-07-30T12:00:00.000Z" }),
    ];
    expect(buildUpcomingTimeline(jobs, NOW, 0).entries).toHaveLength(0);
    expect(buildUpcomingTimeline(jobs, NOW, 1.5).entries).toHaveLength(2);
    expect(buildUpcomingTimeline(jobs, NOW, undefined).entries).toHaveLength(2);
  });

  it("does not mutate the input array order", () => {
    const jobs = [
      job({ id: "late", resetAt: "2026-07-30T15:00:00.000Z" }),
      job({ id: "soon", resetAt: "2026-07-30T11:00:00.000Z" }),
    ];
    buildUpcomingTimeline(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(["late", "soon"]);
  });
});
