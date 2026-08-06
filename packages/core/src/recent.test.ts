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
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-30T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describe("buildRecentActivity", () => {
  it("returns an empty feed for no jobs", () => {
    expect(buildRecentActivity([], NOW)).toEqual({ entries: [], total: 0, hidden: 0 });
  });

  it("orders jobs by updatedAt descending (most recent first)", () => {
    const activity = buildRecentActivity(
      [
        job({ id: "old", updatedAt: "2026-07-30T06:00:00.000Z" }),
        job({ id: "newest", updatedAt: "2026-07-30T09:30:00.000Z" }),
        job({ id: "middle", updatedAt: "2026-07-30T08:00:00.000Z" }),
      ],
      NOW
    );
    expect(activity.entries.map((e) => e.job.id)).toEqual(["newest", "middle", "old"]);
    expect(activity.entries.map((e) => e.position)).toEqual([1, 2, 3]);
    expect(activity.total).toBe(3);
    expect(activity.hidden).toBe(0);
  });

  it("spans every status, not just waiting/terminal ones", () => {
    const statuses: RelayJob["status"][] = [
      "queued",
      "waiting_for_reset",
      "resuming",
      "completed",
      "failed",
      "cancelled",
    ];
    const jobs = statuses.map((status, i) => job({ id: status, status, updatedAt: `2026-07-30T0${i + 1}:00:00.000Z` }));
    const activity = buildRecentActivity(jobs, NOW);
    expect(activity.total).toBe(6);
    // newest updatedAt (cancelled at 06:00) first, queued (01:00) last
    expect(activity.entries[0].job.id).toBe("cancelled");
    expect(activity.entries[5].job.id).toBe("queued");
  });

  it("computes ageMs as now minus updatedAt", () => {
    const activity = buildRecentActivity([job({ updatedAt: "2026-07-30T08:00:00.000Z" })], NOW);
    expect(activity.entries[0].ageMs).toBe(2 * HOUR);
  });

  it("reports ageMs null for an unparseable updatedAt and sorts it last", () => {
    const activity = buildRecentActivity(
      [job({ id: "bad", updatedAt: "not-a-date" }), job({ id: "good", updatedAt: "2026-07-30T09:00:00.000Z" })],
      NOW
    );
    expect(activity.entries.map((e) => e.job.id)).toEqual(["good", "bad"]);
    expect(activity.entries[1].ageMs).toBeNull();
  });

  it("breaks updatedAt ties by createdAt descending, then id ascending", () => {
    const activity = buildRecentActivity(
      [
        job({ id: "b", updatedAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
        job({ id: "a", updatedAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
        job({ id: "c", updatedAt: "2026-07-30T09:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
      ],
      NOW
    );
    // "a" and "c" share the newer createdAt (02:00) -> id asc puts "a" first, then "c"; "b" (01:00) last.
    expect(activity.entries.map((e) => e.job.id)).toEqual(["a", "c", "b"]);
  });

  it("trims to limit but keeps total honest for a 'more not shown' footer", () => {
    const jobs = Array.from({ length: 5 }, (_, i) =>
      job({ id: `j${i}`, updatedAt: `2026-07-30T0${i + 1}:00:00.000Z` })
    );
    const activity = buildRecentActivity(jobs, NOW, 2);
    expect(activity.entries).toHaveLength(2);
    expect(activity.total).toBe(5);
    expect(activity.hidden).toBe(3);
  });

  it("ignores a non-positive-integer limit (shows all)", () => {
    const jobs = [job(), job(), job()];
    expect(buildRecentActivity(jobs, NOW, 2.5).entries).toHaveLength(3);
    expect(buildRecentActivity(jobs, NOW, -1).entries).toHaveLength(3);
    expect(buildRecentActivity(jobs, NOW, 0).entries).toHaveLength(0);
    expect(buildRecentActivity(jobs, NOW, 0).total).toBe(3);
    expect(buildRecentActivity(jobs, NOW, 0).hidden).toBe(3);
  });

  it("does not mutate the input array", () => {
    const jobs = [
      job({ id: "x", updatedAt: "2026-07-30T05:00:00.000Z" }),
      job({ id: "y", updatedAt: "2026-07-30T09:00:00.000Z" }),
    ];
    const before = jobs.map((j) => j.id);
    buildRecentActivity(jobs, NOW);
    expect(jobs.map((j) => j.id)).toEqual(before);
  });
});
