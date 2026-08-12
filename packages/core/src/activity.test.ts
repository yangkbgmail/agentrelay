import { describe, expect, it } from "vitest";
import { activityReason, buildActivityFeed } from "./activity.js";
import type { RateLimitDetection, RelayJob } from "./types.js";

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
    resetAt: "2026-07-30T09:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const DETECTION: RateLimitDetection = {
  pattern: "resets-at-iso",
  rawMatch: "resets at 2026-07-30T09:00:00Z",
  resetAt: "2026-07-30T09:00:00.000Z",
  detectedAt: "2026-07-30T08:00:00.000Z",
};

describe("activityReason", () => {
  it("prefers a recorded error over everything else", () => {
    const reason = activityReason(
      job({ lastError: "Error: boom\n  at foo", lastRateLimit: DETECTION, lastOutputTail: "printed" })
    );
    expect(reason).toEqual({ kind: "error", text: "Error: boom" });
  });

  it("uses the rate-limit detection when there is no error", () => {
    const reason = activityReason(job({ lastRateLimit: DETECTION, lastOutputTail: "printed" }));
    expect(reason.kind).toBe("rate-limit");
    expect(reason.text).toContain("resets-at-iso");
    expect(reason.text).toContain("2026-07-30T09:00:00.000Z");
  });

  it("falls back to the last non-empty output line", () => {
    const reason = activityReason(job({ lastOutputTail: "line one\nline two\n\n" }));
    expect(reason).toEqual({ kind: "output", text: "line two" });
  });

  it("reports 'none' when the job carries no reason at all", () => {
    expect(activityReason(job())).toEqual({ kind: "none", text: "" });
  });

  it("treats a whitespace-only error as no error and moves on", () => {
    const reason = activityReason(job({ lastError: "   \n  ", lastOutputTail: "hello" }));
    expect(reason).toEqual({ kind: "output", text: "hello" });
  });

  it("collapses internal whitespace and caps long reasons", () => {
    const long = `x${" y".repeat(200)}`;
    const reason = activityReason(job({ lastError: long }));
    expect(reason.text.length).toBeLessThanOrEqual(140);
    expect(reason.text.endsWith("…")).toBe(true);
  });
});

describe("buildActivityFeed", () => {
  it("returns an empty feed for no jobs", () => {
    expect(buildActivityFeed([])).toEqual({ entries: [], total: 0, shown: 0, hidden: 0 });
  });

  it("orders newest-updated first", () => {
    const older = job({ id: "a", updatedAt: "2026-07-30T01:00:00.000Z" });
    const newer = job({ id: "b", updatedAt: "2026-07-30T05:00:00.000Z" });
    const mid = job({ id: "c", updatedAt: "2026-07-30T03:00:00.000Z" });
    const feed = buildActivityFeed([older, newer, mid]);
    expect(feed.entries.map((e) => e.job.id)).toEqual(["b", "c", "a"]);
    expect(feed.total).toBe(3);
  });

  it("breaks same-instant ties by id ascending (deterministic)", () => {
    const j1 = job({ id: "zeta", updatedAt: "2026-07-30T02:00:00.000Z" });
    const j2 = job({ id: "alpha", updatedAt: "2026-07-30T02:00:00.000Z" });
    const feed = buildActivityFeed([j1, j2]);
    expect(feed.entries.map((e) => e.job.id)).toEqual(["alpha", "zeta"]);
  });

  it("sinks jobs with an unparseable updatedAt to the bottom", () => {
    const good = job({ id: "good", updatedAt: "2026-07-30T02:00:00.000Z" });
    const bad = job({ id: "bad", updatedAt: "not-a-date" });
    const feed = buildActivityFeed([bad, good]);
    expect(feed.entries.map((e) => e.job.id)).toEqual(["good", "bad"]);
    expect(feed.entries[1].updatedMs).toBeNull();
  });

  it("keeps only the newest N with --limit and reports the rest as hidden", () => {
    const jobs = [
      job({ id: "a", updatedAt: "2026-07-30T01:00:00.000Z" }),
      job({ id: "b", updatedAt: "2026-07-30T04:00:00.000Z" }),
      job({ id: "c", updatedAt: "2026-07-30T03:00:00.000Z" }),
      job({ id: "d", updatedAt: "2026-07-30T02:00:00.000Z" }),
    ];
    const feed = buildActivityFeed(jobs, { limit: 2 });
    expect(feed.entries.map((e) => e.job.id)).toEqual(["b", "c"]);
    expect(feed).toMatchObject({ total: 4, shown: 2, hidden: 2 });
  });

  it("does not mutate the input array order", () => {
    const jobs = [
      job({ id: "a", updatedAt: "2026-07-30T01:00:00.000Z" }),
      job({ id: "b", updatedAt: "2026-07-30T05:00:00.000Z" }),
    ];
    buildActivityFeed(jobs);
    expect(jobs.map((j) => j.id)).toEqual(["a", "b"]);
  });
});
