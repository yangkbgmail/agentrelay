import { describe, expect, it } from "vitest";
import { computeQueueEta } from "./eta.js";
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

describe("computeQueueEta", () => {
  it("reports caught-up on an empty queue", () => {
    expect(computeQueueEta([], NOW)).toEqual({
      waiting: 0,
      dueNow: 0,
      firstResetAt: null,
      lastResetAt: null,
      etaMs: null,
      spanMs: null,
      caughtUp: true,
    });
  });

  it("ignores jobs that are not waiting_for_reset", () => {
    const eta = computeQueueEta(
      [
        job({ status: "completed", resetAt: "2026-07-30T20:00:00.000Z" }),
        job({ status: "queued", resetAt: null }),
        job({ status: "resuming", resetAt: "2026-07-30T22:00:00.000Z" }),
        job({ status: "failed", resetAt: "2026-07-30T23:00:00.000Z" }),
      ],
      NOW
    );
    expect(eta.waiting).toBe(0);
    expect(eta.caughtUp).toBe(true);
  });

  it("excludes a waiting job with a null resetAt (not genuinely parked)", () => {
    const eta = computeQueueEta([job({ resetAt: null }), job({ resetAt: "2026-07-30T14:00:00.000Z" })], NOW);
    expect(eta.waiting).toBe(1);
    expect(eta.lastResetAt).toBe("2026-07-30T14:00:00.000Z");
  });

  it("surfaces an unparseable resetAt as due now — the daemon (listDue) resumes it next", () => {
    // Regression: post-#812 `isJobDue` returns unparseable-resetAt jobs as due,
    // so `eta` must count them too; dropping them (the old behavior) under-counted
    // the exact jobs the daemon resumes next and hid them from the catch-up ETA.
    const eta = computeQueueEta(
      [job({ resetAt: "not-a-date" }), job({ resetAt: "2026-07-30T14:00:00.000Z" })], // future
      NOW
    );
    expect(eta.waiting).toBe(2);
    expect(eta.dueNow).toBe(1); // the unparseable one is due now, the future one isn't
    // The unparseable job is modeled at `now`, so it's the soonest reset instant.
    expect(eta.firstResetAt).toBe("2026-07-30T10:00:00.000Z"); // == NOW, not NaN
    // Catch-up is still gated by the latest (future) reset.
    expect(eta.lastResetAt).toBe("2026-07-30T14:00:00.000Z");
    expect(eta.etaMs).toBe(4 * 60 * 60 * 1000); // 14:00 - 10:00
    expect(eta.caughtUp).toBe(false);
  });

  it("treats an all-unparseable waiting queue as fully due now (etaMs 0)", () => {
    const eta = computeQueueEta([job({ resetAt: "not-a-date" }), job({ resetAt: "still-not-a-date" })], NOW);
    expect(eta.waiting).toBe(2);
    expect(eta.dueNow).toBe(2);
    expect(eta.firstResetAt).toBe("2026-07-30T10:00:00.000Z"); // == NOW
    expect(eta.lastResetAt).toBe("2026-07-30T10:00:00.000Z"); // == NOW
    expect(eta.etaMs).toBe(0); // all due now, loop just hasn't run yet
    expect(eta.spanMs).toBe(0);
    expect(eta.caughtUp).toBe(false); // there ARE jobs to pick up
  });

  it("uses the LATEST reset as the catch-up moment (not the soonest)", () => {
    const eta = computeQueueEta(
      [
        job({ resetAt: "2026-07-30T11:00:00.000Z" }), // soonest
        job({ resetAt: "2026-07-30T15:00:00.000Z" }), // latest
        job({ resetAt: "2026-07-30T13:00:00.000Z" }),
      ],
      NOW
    );
    expect(eta.waiting).toBe(3);
    expect(eta.firstResetAt).toBe("2026-07-30T11:00:00.000Z");
    expect(eta.lastResetAt).toBe("2026-07-30T15:00:00.000Z");
    // ETA is measured to the latest reset: 15:00 - 10:00 = 5h.
    expect(eta.etaMs).toBe(5 * 60 * 60 * 1000);
    // Span from soonest to latest: 11:00 → 15:00 = 4h.
    expect(eta.spanMs).toBe(4 * 60 * 60 * 1000);
    expect(eta.caughtUp).toBe(false);
  });

  it("counts jobs already past due", () => {
    const eta = computeQueueEta(
      [
        job({ resetAt: "2026-07-30T09:00:00.000Z" }), // past
        job({ resetAt: "2026-07-30T10:00:00.000Z" }), // exactly now (due)
        job({ resetAt: "2026-07-30T12:00:00.000Z" }), // future
      ],
      NOW
    );
    expect(eta.dueNow).toBe(2);
    expect(eta.waiting).toBe(3);
  });

  it("returns a negative etaMs when even the last reset has passed", () => {
    const eta = computeQueueEta(
      [job({ resetAt: "2026-07-30T08:00:00.000Z" }), job({ resetAt: "2026-07-30T09:00:00.000Z" })],
      NOW
    );
    expect(eta.etaMs).toBe(-1 * 60 * 60 * 1000);
    expect(eta.dueNow).toBe(2);
  });

  it("has a zero span for a single waiting job", () => {
    const eta = computeQueueEta([job({ resetAt: "2026-07-30T13:00:00.000Z" })], NOW);
    expect(eta.waiting).toBe(1);
    expect(eta.spanMs).toBe(0);
    expect(eta.firstResetAt).toBe(eta.lastResetAt);
  });
});
