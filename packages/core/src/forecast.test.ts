import { describe, expect, it } from "vitest";
import { computeResumeForecast, DEFAULT_FORECAST_BUCKETS } from "./forecast.js";
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
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-13T12:00:00.000Z");
const HOUR = 60 * 60_000;
const at = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

describe("computeResumeForecast", () => {
  it("returns an empty shape for no jobs", () => {
    const f = computeResumeForecast([], { now: NOW });
    expect(f.waiting).toBe(0);
    expect(f.overdue).toBe(0);
    expect(f.nextResetAt).toBeNull();
    expect(f.lastResetAt).toBeNull();
    expect(f.events).toEqual([]);
    // Buckets are always present (empty), one per spec.
    expect(f.buckets).toHaveLength(DEFAULT_FORECAST_BUCKETS.length);
    expect(f.buckets.every((b) => b.count === 0)).toBe(true);
  });

  it("only includes waiting_for_reset jobs with a parseable resetAt", () => {
    const f = computeResumeForecast(
      [
        job({ status: "waiting_for_reset", resetAt: at(30 * 60_000) }),
        job({ status: "queued", resetAt: at(30 * 60_000) }), // wrong status
        job({ status: "completed", resetAt: at(30 * 60_000) }), // terminal
        job({ status: "waiting_for_reset", resetAt: null }), // no reset
        job({ status: "waiting_for_reset", resetAt: "not-a-date" }), // unparseable
      ],
      { now: NOW }
    );
    expect(f.waiting).toBe(1);
  });

  it("computes dueInMs and the due flag relative to now", () => {
    const f = computeResumeForecast(
      [job({ id: "future", resetAt: at(2 * HOUR) }), job({ id: "past", resetAt: at(-30 * 60_000) })],
      { now: NOW }
    );
    const future = f.events.find((e) => e.jobId === "future");
    const past = f.events.find((e) => e.jobId === "past");
    expect(future?.dueInMs).toBe(2 * HOUR);
    expect(future?.due).toBe(false);
    expect(past?.dueInMs).toBe(-30 * 60_000);
    expect(past?.due).toBe(true);
    expect(f.overdue).toBe(1);
  });

  it("sorts events soonest-first, tie-broken by id", () => {
    const f = computeResumeForecast(
      [
        job({ id: "c", resetAt: at(HOUR) }),
        job({ id: "a", resetAt: at(HOUR) }), // same reset as c -> id tiebreak
        job({ id: "b", resetAt: at(10 * 60_000) }), // soonest
      ],
      { now: NOW }
    );
    expect(f.events.map((e) => e.jobId)).toEqual(["b", "a", "c"]);
    expect(f.nextResetAt).toBe(at(10 * 60_000));
    expect(f.lastResetAt).toBe(at(HOUR));
  });

  it("buckets events into the default time horizons", () => {
    const f = computeResumeForecast(
      [
        job({ id: "overdue", resetAt: at(-5 * 60_000) }),
        job({ id: "soon", resetAt: at(30 * 60_000) }),
        job({ id: "mid", resetAt: at(3 * HOUR) }),
        job({ id: "day", resetAt: at(12 * HOUR) }),
        job({ id: "far", resetAt: at(48 * HOUR) }),
      ],
      { now: NOW }
    );
    const byKey = Object.fromEntries(f.buckets.map((b) => [b.key, b.events.map((e) => e.jobId)]));
    expect(byKey.overdue).toEqual(["overdue"]);
    expect(byKey["1h"]).toEqual(["soon"]);
    expect(byKey["6h"]).toEqual(["mid"]);
    expect(byKey["24h"]).toEqual(["day"]);
    expect(byKey.later).toEqual(["far"]);
  });

  it("puts an event exactly on a bucket boundary in the lower (inclusive) bucket", () => {
    const f = computeResumeForecast([job({ id: "edge", resetAt: at(HOUR) })], { now: NOW });
    // dueInMs === 1h exactly: upperMs for "1h" is inclusive, so it lands there.
    const oneHour = f.buckets.find((b) => b.key === "1h");
    expect(oneHour?.events.map((e) => e.jobId)).toEqual(["edge"]);
  });

  it("treats a reset exactly at now (dueInMs 0) as overdue/due", () => {
    const f = computeResumeForecast([job({ id: "nowish", resetAt: at(0) })], { now: NOW });
    expect(f.events[0].due).toBe(true);
    expect(f.overdue).toBe(1);
    expect(f.buckets.find((b) => b.key === "overdue")?.count).toBe(1);
  });

  it("honors a custom bucket spec list", () => {
    const f = computeResumeForecast(
      [job({ id: "a", resetAt: at(5 * 60_000) }), job({ id: "b", resetAt: at(2 * HOUR) })],
      {
        now: NOW,
        buckets: [
          { key: "quick", label: "under 1h", upperMs: HOUR },
          { key: "rest", label: "later", upperMs: null },
        ],
      }
    );
    expect(f.buckets).toHaveLength(2);
    expect(f.buckets[0].events.map((e) => e.jobId)).toEqual(["a"]);
    expect(f.buckets[1].events.map((e) => e.jobId)).toEqual(["b"]);
  });
});
