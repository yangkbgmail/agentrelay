import { describe, expect, it } from "vitest";
import { buildRecentActivity } from "./recent.js";
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
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T02:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-30T10:00:00.000Z");

describe("buildRecentActivity", () => {
  it("returns an empty feed when nothing is resolved", () => {
    const feed = buildRecentActivity([], NOW);
    expect(feed).toEqual({
      entries: [],
      totalResolved: 0,
      hidden: 0,
      byOutcome: { completed: 0, failed: 0, cancelled: 0 },
    });
  });

  it("ignores non-terminal jobs (queued/waiting/resuming)", () => {
    const feed = buildRecentActivity(
      [job({ status: "queued" }), job({ status: "waiting_for_reset" }), job({ status: "resuming" })],
      NOW
    );
    expect(feed.totalResolved).toBe(0);
    expect(feed.entries).toHaveLength(0);
  });

  it("includes completed, failed, and cancelled jobs", () => {
    const feed = buildRecentActivity(
      [job({ status: "completed" }), job({ status: "failed" }), job({ status: "cancelled" })],
      NOW
    );
    expect(feed.totalResolved).toBe(3);
    expect(feed.byOutcome).toEqual({ completed: 1, failed: 1, cancelled: 1 });
  });

  it("drops terminal jobs with an unparseable updatedAt (can't place on the timeline)", () => {
    const feed = buildRecentActivity(
      [job({ id: "bad", updatedAt: "not a date" }), job({ id: "good", updatedAt: "2026-07-30T03:00:00.000Z" })],
      NOW
    );
    expect(feed.totalResolved).toBe(1);
    expect(feed.entries.map((e) => e.job.id)).toEqual(["good"]);
  });

  it("orders most-recently-resolved first and numbers positions from 1", () => {
    const feed = buildRecentActivity(
      [
        job({ id: "old", updatedAt: "2026-07-30T01:00:00.000Z" }),
        job({ id: "new", updatedAt: "2026-07-30T09:00:00.000Z" }),
        job({ id: "mid", updatedAt: "2026-07-30T05:00:00.000Z" }),
      ],
      NOW
    );
    expect(feed.entries.map((e) => e.job.id)).toEqual(["new", "mid", "old"]);
    expect(feed.entries.map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it("breaks ties deterministically by newest createdAt then id descending", () => {
    const feed = buildRecentActivity(
      [
        job({ id: "a", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T05:00:00.000Z" }),
        job({ id: "c", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T05:00:00.000Z" }),
        job({ id: "b", createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T05:00:00.000Z" }),
      ],
      NOW
    );
    // same resolvedAt + same createdAt -> id descending
    expect(feed.entries.map((e) => e.job.id)).toEqual(["c", "b", "a"]);
  });

  it("computes resolution span (updatedAt - createdAt) and time-since-resolved", () => {
    const feed = buildRecentActivity(
      [job({ createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T02:00:00.000Z" })],
      NOW
    );
    const entry = feed.entries[0];
    expect(entry.resolutionMs).toBe(2 * 3600 * 1000);
    expect(entry.resolvedAtMs).toBe(Date.parse("2026-07-30T02:00:00.000Z"));
    expect(entry.resolvedAgoMs).toBe(8 * 3600 * 1000);
  });

  it("nulls the resolution span when createdAt is unparseable or the span is negative", () => {
    const feed = buildRecentActivity(
      [
        job({ id: "bad-created", createdAt: "nope", updatedAt: "2026-07-30T05:00:00.000Z" }),
        job({ id: "skewed", createdAt: "2026-07-30T06:00:00.000Z", updatedAt: "2026-07-30T04:00:00.000Z" }),
      ],
      NOW
    );
    const byId = Object.fromEntries(feed.entries.map((e) => [e.job.id, e.resolutionMs]));
    expect(byId["bad-created"]).toBeNull();
    expect(byId["skewed"]).toBeNull();
  });

  it("clamps resolvedAgoMs to zero for a future updatedAt (clock skew)", () => {
    const feed = buildRecentActivity([job({ updatedAt: "2026-07-30T12:00:00.000Z" })], NOW);
    expect(feed.entries[0].resolvedAgoMs).toBe(0);
  });

  it("filters to requested outcomes, ignoring non-terminal statuses in the list", () => {
    const feed = buildRecentActivity(
      [job({ status: "completed" }), job({ status: "failed" }), job({ status: "cancelled" })],
      NOW,
      { outcomes: ["failed"] }
    );
    expect(feed.totalResolved).toBe(1);
    expect(feed.entries[0].outcome).toBe("failed");
    expect(feed.byOutcome).toEqual({ completed: 0, failed: 1, cancelled: 0 });
  });

  it("treats an empty outcomes list as no filter", () => {
    const feed = buildRecentActivity([job({ status: "completed" }), job({ status: "failed" })], NOW, {
      outcomes: [],
    });
    expect(feed.totalResolved).toBe(2);
  });

  it("trims to limit but keeps totals and byOutcome honest across the full set", () => {
    const feed = buildRecentActivity(
      [
        job({ id: "n1", status: "completed", updatedAt: "2026-07-30T09:00:00.000Z" }),
        job({ id: "n2", status: "failed", updatedAt: "2026-07-30T08:00:00.000Z" }),
        job({ id: "n3", status: "cancelled", updatedAt: "2026-07-30T07:00:00.000Z" }),
      ],
      NOW,
      { limit: 2 }
    );
    expect(feed.entries.map((e) => e.job.id)).toEqual(["n1", "n2"]);
    expect(feed.hidden).toBe(1);
    expect(feed.totalResolved).toBe(3);
    expect(feed.byOutcome).toEqual({ completed: 1, failed: 1, cancelled: 1 });
  });

  it("does not mutate the input array", () => {
    const jobs = [
      job({ id: "x", updatedAt: "2026-07-30T01:00:00.000Z" }),
      job({ id: "y", updatedAt: "2026-07-30T09:00:00.000Z" }),
    ];
    const before = jobs.map((j) => j.id);
    buildRecentActivity(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(before);
  });
});
