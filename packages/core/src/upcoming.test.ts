import { describe, expect, it } from "vitest";
import type { RelayJob } from "./types.js";
import { buildResumeAgenda, RESUME_BUCKETS, type ResumeBucketKey } from "./upcoming.js";

const NOW = Date.parse("2026-07-13T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "proj",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "waiting_for_reset",
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

/** ISO string `deltaMs` from NOW. */
function resetAt(deltaMs: number): string {
  return new Date(NOW + deltaMs).toISOString();
}

function bucket(agenda: ReturnType<typeof buildResumeAgenda>, key: ResumeBucketKey) {
  const found = agenda.buckets.find((b) => b.key === key);
  if (!found) throw new Error(`bucket ${key} missing`);
  return found;
}

describe("buildResumeAgenda", () => {
  it("returns an empty, all-buckets-present shape for no jobs", () => {
    const agenda = buildResumeAgenda([], NOW);
    expect(agenda.totalWaiting).toBe(0);
    expect(agenda.nextResetAt).toBeNull();
    expect(agenda.buckets.map((b) => b.key)).toEqual(RESUME_BUCKETS.map((d) => d.key));
    expect(agenda.buckets.every((b) => b.entries.length === 0)).toBe(true);
  });

  it("only considers waiting_for_reset jobs with a parseable resetAt", () => {
    const jobs = [
      job({ status: "queued", resetAt: resetAt(HOUR) }),
      job({ status: "completed", resetAt: resetAt(HOUR) }),
      job({ status: "resuming", resetAt: resetAt(HOUR) }),
      job({ status: "waiting_for_reset", resetAt: null }),
      job({ status: "waiting_for_reset", resetAt: "not-a-date" }),
      job({ status: "waiting_for_reset", resetAt: resetAt(HOUR) }),
    ];
    const agenda = buildResumeAgenda(jobs, NOW);
    expect(agenda.totalWaiting).toBe(1);
  });

  it("buckets by time window relative to now", () => {
    const jobs = [
      job({ id: "overdue", resetAt: resetAt(-HOUR) }),
      job({ id: "due-boundary", resetAt: resetAt(0) }),
      job({ id: "in-30m", resetAt: resetAt(30 * 60 * 1000) }),
      job({ id: "in-3h", resetAt: resetAt(3 * HOUR) }),
      job({ id: "in-2d", resetAt: resetAt(48 * HOUR) }),
    ];
    const agenda = buildResumeAgenda(jobs, NOW);
    expect(bucket(agenda, "overdue").entries.map((e) => e.jobId)).toEqual(["overdue", "due-boundary"]);
    expect(bucket(agenda, "hour").entries.map((e) => e.jobId)).toEqual(["in-30m"]);
    expect(bucket(agenda, "today").entries.map((e) => e.jobId)).toEqual(["in-3h"]);
    expect(bucket(agenda, "later").entries.map((e) => e.jobId)).toEqual(["in-2d"]);
    expect(agenda.totalWaiting).toBe(5);
  });

  it("places the exactly-1h job in the hour bucket and the exactly-24h job in today", () => {
    const jobs = [
      job({ id: "at-1h", resetAt: resetAt(HOUR) }),
      job({ id: "at-24h", resetAt: resetAt(24 * HOUR) }),
      job({ id: "just-past-24h", resetAt: resetAt(24 * HOUR + 1) }),
    ];
    const agenda = buildResumeAgenda(jobs, NOW);
    expect(bucket(agenda, "hour").entries.map((e) => e.jobId)).toEqual(["at-1h"]);
    expect(bucket(agenda, "today").entries.map((e) => e.jobId)).toEqual(["at-24h"]);
    expect(bucket(agenda, "later").entries.map((e) => e.jobId)).toEqual(["just-past-24h"]);
  });

  it("sorts entries soonest-first, tie-breaking by createdAt then id", () => {
    const shared = resetAt(2 * HOUR);
    const jobs = [
      job({ id: "b", resetAt: shared, createdAt: "2026-07-13T01:00:00.000Z" }),
      job({ id: "a", resetAt: shared, createdAt: "2026-07-13T01:00:00.000Z" }),
      job({ id: "earlier-created", resetAt: shared, createdAt: "2026-07-13T00:00:00.000Z" }),
      job({ id: "sooner", resetAt: resetAt(90 * 60 * 1000) }),
    ];
    const agenda = buildResumeAgenda(jobs, NOW);
    // sooner reset first, then same-reset ordered by createdAt asc, then id asc.
    expect(bucket(agenda, "today").entries.map((e) => e.jobId)).toEqual(["sooner", "earlier-created", "a", "b"]);
  });

  it("exposes dueInMs, due, and nextResetAt", () => {
    const jobs = [
      job({ id: "later", resetAt: resetAt(5 * HOUR) }),
      job({ id: "overdue", resetAt: resetAt(-2 * HOUR) }),
    ];
    const agenda = buildResumeAgenda(jobs, NOW);
    expect(agenda.nextResetAt).toBe(resetAt(-2 * HOUR));
    const overdue = bucket(agenda, "overdue").entries[0];
    expect(overdue.due).toBe(true);
    expect(overdue.dueInMs).toBe(-2 * HOUR);
    const later = bucket(agenda, "today").entries[0];
    expect(later.due).toBe(false);
    expect(later.dueInMs).toBe(5 * HOUR);
  });
});
