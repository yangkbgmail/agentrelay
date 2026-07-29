import { describe, expect, it } from "vitest";
import { computeResetClock, jobResetInstant } from "./clock.js";
import type { AgentTool, JobStatus, RateLimitDetection, RelayJob } from "./types.js";

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

function detection(overrides: Partial<RateLimitDetection> = {}): RateLimitDetection {
  return {
    pattern: "iso-timestamp",
    rawMatch: "reset at ...",
    resetAt: "2026-07-13T05:00:00.000Z",
    detectedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("jobResetInstant", () => {
  it("prefers the persisted detection reset over the live resetAt", () => {
    const j = job({
      resetAt: "2026-07-13T09:00:00.000Z",
      lastRateLimit: detection({ resetAt: "2026-07-13T05:00:00.000Z" }),
    });
    expect(jobResetInstant(j)).toBe("2026-07-13T05:00:00.000Z");
  });

  it("falls back to job.resetAt when there is no detection", () => {
    const j = job({ resetAt: "2026-07-13T09:00:00.000Z", lastRateLimit: null });
    expect(jobResetInstant(j)).toBe("2026-07-13T09:00:00.000Z");
  });

  it("falls back to job.resetAt when the detection reset is unparseable", () => {
    const j = job({
      resetAt: "2026-07-13T09:00:00.000Z",
      lastRateLimit: detection({ resetAt: "not-a-date" }),
    });
    expect(jobResetInstant(j)).toBe("2026-07-13T09:00:00.000Z");
  });

  it("returns null when neither timestamp is usable", () => {
    expect(jobResetInstant(job({ resetAt: null, lastRateLimit: null }))).toBeNull();
    expect(jobResetInstant(job({ resetAt: "garbage", lastRateLimit: null }))).toBeNull();
  });
});

describe("computeResetClock", () => {
  it("returns an all-zero 24-bucket day with no peak for an empty store", () => {
    const summary = computeResetClock([]);
    expect(summary.total).toBe(0);
    expect(summary.withReset).toBe(0);
    expect(summary.withoutReset).toBe(0);
    expect(summary.timeZone).toBe("utc");
    expect(summary.peakHour).toBeNull();
    expect(summary.buckets).toHaveLength(24);
    expect(summary.buckets.every((b) => b.count === 0)).toBe(true);
    // Buckets are ordered 0..23 with index === hour.
    expect(summary.buckets.map((b) => b.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it("bins reset instants by their UTC hour", () => {
    const summary = computeResetClock([
      job({ resetAt: "2026-07-13T05:00:00.000Z" }),
      job({ resetAt: "2026-07-13T05:30:00.000Z" }),
      job({ resetAt: "2026-07-13T14:15:00.000Z" }),
    ]);
    expect(summary.withReset).toBe(3);
    expect(summary.withoutReset).toBe(0);
    expect(summary.buckets[5].count).toBe(2);
    expect(summary.buckets[14].count).toBe(1);
    expect(summary.peakHour).toBe(5);
  });

  it("counts jobs without a usable reset as withoutReset, not a bucket", () => {
    const summary = computeResetClock([
      job({ resetAt: "2026-07-13T08:00:00.000Z" }),
      job({ resetAt: null, lastRateLimit: null }),
      job({ resetAt: "nonsense", lastRateLimit: null }),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.withReset).toBe(1);
    expect(summary.withoutReset).toBe(2);
    expect(summary.buckets[8].count).toBe(1);
    expect(summary.buckets.reduce((s, b) => s + b.count, 0)).toBe(1);
  });

  it("breaks a peak tie by the earliest hour", () => {
    const summary = computeResetClock([
      job({ resetAt: "2026-07-13T03:00:00.000Z" }),
      job({ resetAt: "2026-07-13T20:00:00.000Z" }),
    ]);
    // Both hours have count 1; the earlier hour (3) wins.
    expect(summary.peakHour).toBe(3);
  });

  it("uses the detection reset instant, not the live resetAt, when both exist", () => {
    const summary = computeResetClock([
      job({
        status: "completed" as JobStatus,
        resetAt: null,
        lastRateLimit: detection({ resetAt: "2026-07-13T11:00:00.000Z" }),
      }),
    ]);
    expect(summary.withReset).toBe(1);
    expect(summary.buckets[11].count).toBe(1);
  });

  it("bins in local time when asked", () => {
    // Pick an instant and assert it lands in the host-local hour, whatever the
    // runner's TZ is — this stays correct without pinning process.env.TZ.
    const iso = "2026-07-13T05:00:00.000Z";
    const localHour = new Date(iso).getHours();
    const summary = computeResetClock([job({ resetAt: iso })], { local: true });
    expect(summary.timeZone).toBe("local");
    expect(summary.buckets[localHour].count).toBe(1);
    expect(summary.peakHour).toBe(localHour);
  });
});
