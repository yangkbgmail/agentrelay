import { describe, expect, it } from "vitest";
import type { RelayJob } from "./types.js";
import { buildResumeWaves, DEFAULT_WAVE_WINDOW_MS } from "./waves.js";

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
const HOUR = 60 * 60 * 1000;

/** resetAt ISO for `hours` after NOW. */
function resetIn(hours: number): string {
  return new Date(NOW + hours * HOUR).toISOString();
}

describe("buildResumeWaves", () => {
  it("returns an empty histogram when nothing is waiting", () => {
    const w = buildResumeWaves([], NOW);
    expect(w.windows).toEqual([]);
    expect(w.totalWaiting).toBe(0);
    expect(w.dueNow).toBe(0);
    expect(w.peakCount).toBe(0);
    expect(w.peakIndex).toBeNull();
    expect(w.beyondHorizon).toBe(0);
    expect(w.horizonMs).toBe(0);
    expect(w.windowMs).toBe(DEFAULT_WAVE_WINDOW_MS);
  });

  it("ignores jobs that are not waiting_for_reset", () => {
    const w = buildResumeWaves(
      [
        job({ status: "completed", resetAt: resetIn(1) }),
        job({ status: "queued", resetAt: resetIn(1) }),
        job({ status: "resuming", resetAt: resetIn(1) }),
        job({ status: "failed", resetAt: resetIn(1) }),
      ],
      NOW
    );
    expect(w.totalWaiting).toBe(0);
    expect(w.windows).toEqual([]);
  });

  it("ignores waiting jobs with a missing or unparseable resetAt", () => {
    const w = buildResumeWaves(
      [job({ resetAt: null }), job({ resetAt: "not a date" }), job({ resetAt: resetIn(1) })],
      NOW
    );
    expect(w.totalWaiting).toBe(1);
    expect(w.peakCount).toBe(1);
  });

  it("buckets jobs by which hour window they come due in", () => {
    const w = buildResumeWaves(
      [
        job({ resetAt: resetIn(0.5) }), // window 0
        job({ resetAt: resetIn(0.9) }), // window 0
        job({ resetAt: resetIn(2.5) }), // window 2
      ],
      NOW
    );
    expect(w.windows.map((b) => b.count)).toEqual([2, 0, 1]);
    expect(w.windows[0].offsetMs).toBe(0);
    expect(w.windows[1].offsetMs).toBe(HOUR);
    expect(w.windows[2].endMs).toBe(NOW + 3 * HOUR);
    expect(w.totalWaiting).toBe(3);
    expect(w.horizonMs).toBe(3 * HOUR);
  });

  it("keeps empty windows between resumes so the histogram shows gaps", () => {
    const w = buildResumeWaves([job({ resetAt: resetIn(0.1) }), job({ resetAt: resetIn(4.1) })], NOW);
    // window 0 has one, windows 1-3 empty, window 4 has one
    expect(w.windows).toHaveLength(5);
    expect(w.windows.map((b) => b.count)).toEqual([1, 0, 0, 0, 1]);
  });

  it("folds already-due jobs into window 0 and counts them in dueNow", () => {
    const w = buildResumeWaves(
      [
        job({ resetAt: resetIn(-2) }), // overdue
        job({ resetAt: resetIn(-0.1) }), // overdue
        job({ resetAt: resetIn(1.5) }), // window 1
      ],
      NOW
    );
    expect(w.dueNow).toBe(2);
    expect(w.windows[0].count).toBe(2);
    expect(w.windows[1].count).toBe(1);
  });

  it("reports the busiest window as the peak, earliest wins ties", () => {
    const w = buildResumeWaves(
      [
        job({ resetAt: resetIn(0.2) }),
        job({ resetAt: resetIn(0.3) }),
        job({ resetAt: resetIn(2.2) }),
        job({ resetAt: resetIn(2.4) }),
      ],
      NOW
    );
    // Both window 0 and window 2 have 2 — earliest (index 0) is the peak.
    expect(w.peakCount).toBe(2);
    expect(w.peakIndex).toBe(0);
  });

  it("honors a custom window width", () => {
    const w = buildResumeWaves(
      [job({ resetAt: resetIn(0.25) }), job({ resetAt: resetIn(0.75) })],
      NOW,
      { windowMs: 30 * 60 * 1000 } // 30m
    );
    // 15m -> window 0, 45m -> window 1
    expect(w.windowMs).toBe(30 * 60 * 1000);
    expect(w.windows.map((b) => b.count)).toEqual([1, 1]);
  });

  it("counts jobs past the maxWindows horizon in beyondHorizon, not a window", () => {
    const w = buildResumeWaves(
      [
        job({ resetAt: resetIn(0.5) }), // window 0 (shown)
        job({ resetAt: resetIn(5) }), // window 5 (beyond a 2-window cap)
        job({ resetAt: resetIn(9) }), // window 9 (beyond)
      ],
      NOW,
      { maxWindows: 2 }
    );
    expect(w.windows).toHaveLength(1);
    expect(w.windows[0].count).toBe(1);
    expect(w.beyondHorizon).toBe(2);
    expect(w.totalWaiting).toBe(3);
  });

  it("falls back to defaults for non-positive window or maxWindows", () => {
    const w = buildResumeWaves([job({ resetAt: resetIn(1) })], NOW, { windowMs: 0, maxWindows: 0 });
    expect(w.windowMs).toBe(DEFAULT_WAVE_WINDOW_MS);
    expect(w.windows.length).toBeGreaterThan(0);
  });
});
