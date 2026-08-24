import { describe, expect, it } from "vitest";
import { selectNextResume } from "../src/next.js";
import type { RelayJob } from "../src/types.js";

const NOW = Date.parse("2026-07-13T00:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "id",
    project: "proj",
    tool: "claude-code",
    command: ["echo"],
    cwd: "/tmp",
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

describe("selectNextResume", () => {
  it("returns null for an empty queue", () => {
    expect(selectNextResume([], NOW)).toBeNull();
  });

  it("returns null when no job is waiting for a reset", () => {
    const jobs = [
      job({ id: "a", status: "completed", resetAt: at(-3600_000) }),
      job({ id: "b", status: "resuming", resetAt: at(3600_000) }),
      job({ id: "c", status: "queued", resetAt: null }),
      job({ id: "d", status: "failed", resetAt: null }),
      job({ id: "e", status: "cancelled", resetAt: at(-1000) }),
    ];
    expect(selectNextResume(jobs, NOW)).toBeNull();
  });

  it("picks the waiting job with the earliest reset time", () => {
    const next = selectNextResume(
      [
        job({ id: "a", resetAt: at(3 * 3600_000) }),
        job({ id: "b", resetAt: at(1 * 3600_000) }),
        job({ id: "c", resetAt: at(2 * 3600_000) }),
      ],
      NOW
    );
    expect(next?.job.id).toBe("b");
    expect(next?.waitingBehind).toBe(2);
  });

  it("ignores a waiting job with a null resetAt (not genuinely parked)", () => {
    const next = selectNextResume([job({ id: "a", resetAt: null }), job({ id: "c", resetAt: at(90 * 60_000) })], NOW);
    expect(next?.job.id).toBe("c");
    expect(next?.waitingBehind).toBe(0);
  });

  it("surfaces an unparseable resetAt as due now — the daemon (listDue) resumes it next", () => {
    // Regression: post-#812 `isJobDue` returns unparseable-resetAt jobs as due,
    // so `next` must too; filtering them out hid the exact job the daemon runs.
    const next = selectNextResume(
      [job({ id: "future", resetAt: at(90 * 60_000) }), job({ id: "bad", resetAt: "not-a-date" })],
      NOW
    );
    expect(next?.job.id).toBe("bad"); // sorts ahead of any real timestamp
    expect(next?.due).toBe(true);
    expect(next?.dueInMs).toBe(0); // not NaN
    expect(next?.waitingBehind).toBe(1);
  });

  it("reports dueInMs and due=false for a future reset", () => {
    const next = selectNextResume([job({ id: "a", resetAt: at(30 * 60_000) })], NOW);
    expect(next?.dueInMs).toBe(30 * 60_000);
    expect(next?.due).toBe(false);
  });

  it("reports due=true once the reset time has passed (or is exactly now)", () => {
    expect(selectNextResume([job({ resetAt: at(-1) })], NOW)?.due).toBe(true);
    expect(selectNextResume([job({ resetAt: at(0) })], NOW)?.due).toBe(true);
    const overdue = selectNextResume([job({ resetAt: at(-5 * 60_000) })], NOW);
    expect(overdue?.dueInMs).toBe(-5 * 60_000);
  });

  it("breaks reset-time ties deterministically by createdAt then id", () => {
    const sameReset = at(60 * 60_000);
    const byCreated = selectNextResume(
      [
        job({ id: "younger", resetAt: sameReset, createdAt: at(-100) }),
        job({ id: "older", resetAt: sameReset, createdAt: at(-9999) }),
      ],
      NOW
    );
    expect(byCreated?.job.id).toBe("older");

    const byId = selectNextResume(
      [
        job({ id: "zeta", resetAt: sameReset, createdAt: at(-500) }),
        job({ id: "alpha", resetAt: sameReset, createdAt: at(-500) }),
      ],
      NOW
    );
    expect(byId?.job.id).toBe("alpha");
  });
});
