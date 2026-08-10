import { describe, expect, it } from "vitest";
import { computeQueueForecast, normalizeJobDurationMs } from "./forecast.js";
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
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("normalizeJobDurationMs", () => {
  it("floors fractional values and keeps non-negative integers", () => {
    expect(normalizeJobDurationMs(2.9, 0)).toBe(2);
    expect(normalizeJobDurationMs(0, 999)).toBe(0);
  });
  it("falls back for undefined / NaN / Infinity / negative", () => {
    expect(normalizeJobDurationMs(undefined, 120_000)).toBe(120_000);
    expect(normalizeJobDurationMs(Number.NaN, 120_000)).toBe(120_000);
    expect(normalizeJobDurationMs(Number.POSITIVE_INFINITY, 120_000)).toBe(120_000);
    expect(normalizeJobDurationMs(-5, 120_000)).toBe(120_000);
  });
  it("floors a fractional fallback too", () => {
    expect(normalizeJobDurationMs(-1, 2.7)).toBe(2);
  });
});

describe("computeQueueForecast", () => {
  it("reports caught-up on an empty queue", () => {
    const f = computeQueueForecast([], { now: NOW, maxConcurrent: 2, jobDurationMs: MIN });
    expect(f.caughtUp).toBe(true);
    expect(f.waiting).toBe(0);
    expect(f.entries).toEqual([]);
    expect(f.drainMs).toBeNull();
    expect(f.drainAt).toBeNull();
    expect(f.naiveEtaMs).toBeNull();
    expect(f.contentionMs).toBeNull();
    expect(f.maxQueuedMs).toBe(0);
    // Options still echoed back for the renderer.
    expect(f.maxConcurrent).toBe(2);
    expect(f.jobDurationMs).toBe(MIN);
  });

  it("ignores jobs that are not waiting_for_reset and unparseable resets", () => {
    const f = computeQueueForecast(
      [
        job({ status: "completed", resetAt: "2026-07-30T20:00:00.000Z" }),
        job({ status: "queued", resetAt: null }),
        job({ status: "waiting_for_reset", resetAt: "not-a-date" }),
        job({ status: "waiting_for_reset", resetAt: "2026-07-30T14:00:00.000Z" }),
      ],
      { now: NOW, maxConcurrent: 1, jobDurationMs: MIN }
    );
    expect(f.waiting).toBe(1);
    expect(f.lastResetAt).toBe("2026-07-30T14:00:00.000Z");
  });

  it("with enough slots there is no contention: drain = lastReset + duration", () => {
    // Three jobs all due at the same reset, 3 slots → they run fully in parallel.
    const f = computeQueueForecast(
      [
        job({ id: "a", resetAt: "2026-07-30T12:00:00.000Z" }),
        job({ id: "b", resetAt: "2026-07-30T12:00:00.000Z" }),
        job({ id: "c", resetAt: "2026-07-30T12:00:00.000Z" }),
      ],
      { now: NOW, maxConcurrent: 3, jobDurationMs: 30 * MIN }
    );
    // reset is 2h out, each takes 30m, all parallel → drain 2h30m.
    expect(f.naiveEtaMs).toBe(2 * HOUR);
    expect(f.drainMs).toBe(2 * HOUR + 30 * MIN);
    expect(f.contentionMs).toBe(0);
    expect(f.maxQueuedMs).toBe(0);
    // Each ran in its own slot.
    expect(new Set(f.entries.map((e) => e.slot)).size).toBe(3);
  });

  it("serializes a herd behind a single slot (contention)", () => {
    // Three jobs due together, but only ONE slot → they run back-to-back.
    const f = computeQueueForecast(
      [
        job({ id: "a", resetAt: "2026-07-30T12:00:00.000Z" }),
        job({ id: "b", resetAt: "2026-07-30T12:00:00.000Z" }),
        job({ id: "c", resetAt: "2026-07-30T12:00:00.000Z" }),
      ],
      { now: NOW, maxConcurrent: 1, jobDurationMs: 30 * MIN }
    );
    // reset 2h out; 3 jobs × 30m serial → last finishes 2h + 90m = 3h30m.
    expect(f.drainMs).toBe(2 * HOUR + 90 * MIN);
    // Unavoidable = naiveEta(2h) + one duration(30m); contention = 60m of queuing.
    expect(f.contentionMs).toBe(60 * MIN);
    // Worst queuing wait: the third job waits 2×30m for a slot.
    expect(f.maxQueuedMs).toBe(60 * MIN);
    // All ran on the only slot.
    expect(f.entries.every((e) => e.slot === 0)).toBe(true);
  });

  it("two slots drain a herd of four in two waves", () => {
    const f = computeQueueForecast(
      [
        job({ id: "a", resetAt: "2026-07-30T12:00:00.000Z" }),
        job({ id: "b", resetAt: "2026-07-30T12:00:00.000Z" }),
        job({ id: "c", resetAt: "2026-07-30T12:00:00.000Z" }),
        job({ id: "d", resetAt: "2026-07-30T12:00:00.000Z" }),
      ],
      { now: NOW, maxConcurrent: 2, jobDurationMs: 30 * MIN }
    );
    // 4 jobs, 2 slots, 30m each → two waves → drain 2h + 60m.
    expect(f.drainMs).toBe(2 * HOUR + 60 * MIN);
    expect(f.contentionMs).toBe(30 * MIN);
    expect(f.maxQueuedMs).toBe(30 * MIN);
  });

  it("staggered resets keep a single slot busy without idle gaps", () => {
    // Jobs 30m apart, each taking 60m → the slot never goes idle after job a.
    const f = computeQueueForecast(
      [
        job({ id: "a", resetAt: "2026-07-30T11:00:00.000Z" }),
        job({ id: "b", resetAt: "2026-07-30T11:30:00.000Z" }),
        job({ id: "c", resetAt: "2026-07-30T12:00:00.000Z" }),
      ],
      { now: NOW, maxConcurrent: 1, jobDurationMs: 60 * MIN }
    );
    // a: 11:00→12:00, b ready 11:30 but slot busy until 12:00 → 12:00→13:00,
    // c ready 12:00 but slot busy until 13:00 → 13:00→14:00. Drain = 14:00-10:00.
    expect(f.drainMs).toBe(4 * HOUR);
    // b waited 30m, c waited 60m.
    expect(f.maxQueuedMs).toBe(60 * MIN);
    const c = f.entries.find((e) => e.jobId === "c")!;
    expect(c.readyMs).toBe(2 * HOUR); // 12:00 - 10:00
    expect(c.startMs).toBe(3 * HOUR); // 13:00 - 10:00
    expect(c.finishMs).toBe(4 * HOUR); // 14:00 - 10:00
    expect(c.queuedMs).toBe(HOUR);
  });

  it("clamps release to now when a reset is already past due", () => {
    const f = computeQueueForecast(
      [job({ id: "a", resetAt: "2026-07-30T08:00:00.000Z" })], // 2h past
      { now: NOW, maxConcurrent: 1, jobDurationMs: 10 * MIN }
    );
    // readyMs floors at 0 (not negative); starts now, finishes in 10m.
    expect(f.entries[0].readyMs).toBe(0);
    expect(f.entries[0].startMs).toBe(0);
    expect(f.drainMs).toBe(10 * MIN);
    expect(f.naiveEtaMs).toBe(-2 * HOUR);
    // contention clamps to 0 even though naiveEta is negative.
    expect(f.contentionMs).toBe(0);
  });

  it("entries are ordered by finish time", () => {
    const f = computeQueueForecast(
      [
        job({ id: "late", resetAt: "2026-07-30T15:00:00.000Z" }),
        job({ id: "early", resetAt: "2026-07-30T11:00:00.000Z" }),
        job({ id: "mid", resetAt: "2026-07-30T13:00:00.000Z" }),
      ],
      { now: NOW, maxConcurrent: 3, jobDurationMs: MIN }
    );
    expect(f.entries.map((e) => e.jobId)).toEqual(["early", "mid", "late"]);
  });

  it("normalizes a bad concurrency to serial (1)", () => {
    const f = computeQueueForecast(
      [job({ id: "a", resetAt: "2026-07-30T12:00:00.000Z" }), job({ id: "b", resetAt: "2026-07-30T12:00:00.000Z" })],
      { now: NOW, maxConcurrent: 0, jobDurationMs: 10 * MIN }
    );
    expect(f.maxConcurrent).toBe(1);
    // Serial: second job waits for the first.
    expect(f.drainMs).toBe(2 * HOUR + 20 * MIN);
  });

  it("a zero duration reduces the drain to the plain eta", () => {
    const f = computeQueueForecast(
      [job({ id: "a", resetAt: "2026-07-30T12:00:00.000Z" }), job({ id: "b", resetAt: "2026-07-30T14:00:00.000Z" })],
      { now: NOW, maxConcurrent: 1, jobDurationMs: 0 }
    );
    // With no runtime, drain == lastReset == naiveEta, no contention.
    expect(f.drainMs).toBe(f.naiveEtaMs);
    expect(f.drainMs).toBe(4 * HOUR);
    expect(f.contentionMs).toBe(0);
  });
});
