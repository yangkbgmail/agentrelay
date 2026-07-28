import { describe, expect, it } from "vitest";
import type { AgentTool, JobStatus, RelayJob } from "./types.js";
import {
  computeResumeSchedule,
  RESUME_BUCKETS,
  type ResumeBucketKey,
  WITHIN_DAY_MS,
  WITHIN_HOUR_MS,
} from "./upcoming.js";

const NOW = Date.parse("2026-07-13T12:00:00.000Z");

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "proj",
    tool: "claude-code" as AgentTool,
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "waiting_for_reset" as JobStatus,
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

/** A `waiting_for_reset` job whose reset is `offsetMs` from NOW. */
function waiting(offsetMs: number, overrides: Partial<RelayJob> = {}): RelayJob {
  return job({ status: "waiting_for_reset", resetAt: new Date(NOW + offsetMs).toISOString(), ...overrides });
}

function bucket(schedule: ReturnType<typeof computeResumeSchedule>, key: ResumeBucketKey) {
  const b = schedule.buckets.find((x) => x.key === key);
  if (!b) throw new Error(`missing bucket ${key}`);
  return b;
}

describe("computeResumeSchedule", () => {
  it("returns all four buckets in chronological order, even when empty", () => {
    const s = computeResumeSchedule([], NOW);
    expect(s.buckets.map((b) => b.key)).toEqual(RESUME_BUCKETS.map((b) => b.key));
    expect(s.totalWaiting).toBe(0);
    expect(s.nextResetAt).toBeNull();
    for (const b of s.buckets) {
      expect(b.count).toBe(0);
      expect(b.earliestResetAt).toBeNull();
      expect(b.earliestDueInMs).toBeNull();
    }
  });

  it("classifies a job into the correct time window", () => {
    const s = computeResumeSchedule(
      [
        waiting(-5 * 60_000), // 5m in the past -> overdue
        waiting(30 * 60_000), // 30m -> within 1 hour
        waiting(6 * WITHIN_HOUR_MS), // 6h -> within 24 hours
        waiting(3 * WITHIN_DAY_MS), // 3 days -> later
      ],
      NOW
    );
    expect(bucket(s, "overdue").count).toBe(1);
    expect(bucket(s, "within_hour").count).toBe(1);
    expect(bucket(s, "within_day").count).toBe(1);
    expect(bucket(s, "later").count).toBe(1);
    expect(s.totalWaiting).toBe(4);
  });

  it("treats a reset exactly at now as overdue (boundary is inclusive of 0)", () => {
    const s = computeResumeSchedule([waiting(0)], NOW);
    expect(bucket(s, "overdue").count).toBe(1);
    expect(bucket(s, "overdue").earliestDueInMs).toBe(0);
  });

  it("puts the exact 1-hour boundary in the within-day bucket (window is [1h, 24h))", () => {
    const atHour = computeResumeSchedule([waiting(WITHIN_HOUR_MS)], NOW);
    expect(bucket(atHour, "within_hour").count).toBe(0);
    expect(bucket(atHour, "within_day").count).toBe(1);

    const atDay = computeResumeSchedule([waiting(WITHIN_DAY_MS)], NOW);
    expect(bucket(atDay, "within_day").count).toBe(0);
    expect(bucket(atDay, "later").count).toBe(1);
  });

  it("surfaces the soonest reset per bucket and overall", () => {
    const s = computeResumeSchedule(
      [
        waiting(50 * 60_000), // 50m
        waiting(20 * 60_000), // 20m (soonest in within_hour)
        waiting(2 * WITHIN_DAY_MS), // 2d
      ],
      NOW
    );
    const within = bucket(s, "within_hour");
    expect(within.count).toBe(2);
    expect(within.earliestResetAt).toBe(new Date(NOW + 20 * 60_000).toISOString());
    expect(within.earliestDueInMs).toBe(20 * 60_000);
    expect(s.nextResetAt).toBe(new Date(NOW + 20 * 60_000).toISOString());
  });

  it("ignores active and terminal jobs — only waiting_for_reset counts", () => {
    const s = computeResumeSchedule(
      [
        waiting(10 * 60_000),
        job({ status: "queued", resetAt: null }),
        job({ status: "resuming", resetAt: new Date(NOW + 60_000).toISOString() }),
        job({ status: "completed", resetAt: null }),
        job({ status: "failed", resetAt: null }),
        job({ status: "cancelled", resetAt: null }),
      ],
      NOW
    );
    expect(s.totalWaiting).toBe(1);
    expect(bucket(s, "within_hour").count).toBe(1);
  });

  it("skips a waiting job with a null or unparseable resetAt", () => {
    const s = computeResumeSchedule(
      [
        job({ status: "waiting_for_reset", resetAt: null }),
        job({ status: "waiting_for_reset", resetAt: "not-a-date" }),
        waiting(15 * 60_000),
      ],
      NOW
    );
    expect(s.totalWaiting).toBe(1);
    expect(s.nextResetAt).toBe(new Date(NOW + 15 * 60_000).toISOString());
  });

  it("sums bucket counts to totalWaiting", () => {
    const s = computeResumeSchedule(
      [waiting(-1000), waiting(-2000), waiting(5 * 60_000), waiting(2 * WITHIN_HOUR_MS)],
      NOW
    );
    const summed = s.buckets.reduce((n, b) => n + b.count, 0);
    expect(summed).toBe(s.totalWaiting);
    expect(s.totalWaiting).toBe(4);
    expect(bucket(s, "overdue").count).toBe(2);
  });
});
