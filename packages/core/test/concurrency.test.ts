import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CONCURRENT,
  mapWithConcurrency,
  maxConcurrentFromEnv,
  normalizeMaxConcurrent,
} from "../src/concurrency.js";

describe("normalizeMaxConcurrent", () => {
  it("keeps positive integers", () => {
    expect(normalizeMaxConcurrent(1)).toBe(1);
    expect(normalizeMaxConcurrent(4)).toBe(4);
  });

  it("floors fractional values", () => {
    expect(normalizeMaxConcurrent(2.9)).toBe(2);
    expect(normalizeMaxConcurrent(1.1)).toBe(1);
  });

  it("falls back to the default for unusable inputs", () => {
    expect(normalizeMaxConcurrent(undefined)).toBe(DEFAULT_MAX_CONCURRENT);
    expect(normalizeMaxConcurrent(0)).toBe(DEFAULT_MAX_CONCURRENT);
    expect(normalizeMaxConcurrent(-3)).toBe(DEFAULT_MAX_CONCURRENT);
    expect(normalizeMaxConcurrent(Number.NaN)).toBe(DEFAULT_MAX_CONCURRENT);
    expect(normalizeMaxConcurrent(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MAX_CONCURRENT);
  });
});

describe("maxConcurrentFromEnv", () => {
  it("defaults to serial when unset or blank", () => {
    expect(maxConcurrentFromEnv({})).toBe(1);
    expect(maxConcurrentFromEnv({ AGENTRELAY_MAX_CONCURRENT: "" })).toBe(1);
    expect(maxConcurrentFromEnv({ AGENTRELAY_MAX_CONCURRENT: "   " })).toBe(1);
  });

  it("reads a positive integer", () => {
    expect(maxConcurrentFromEnv({ AGENTRELAY_MAX_CONCURRENT: "5" })).toBe(5);
    expect(maxConcurrentFromEnv({ AGENTRELAY_MAX_CONCURRENT: "3.7" })).toBe(3);
  });

  it("does not silently disable relaying on a typo (falls back to serial, never 0)", () => {
    expect(maxConcurrentFromEnv({ AGENTRELAY_MAX_CONCURRENT: "abc" })).toBe(1);
    expect(maxConcurrentFromEnv({ AGENTRELAY_MAX_CONCURRENT: "0" })).toBe(1);
    expect(maxConcurrentFromEnv({ AGENTRELAY_MAX_CONCURRENT: "-2" })).toBe(1);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves result order regardless of completion order", async () => {
    // Later items resolve sooner, so a naive push-on-finish would reorder them.
    const items = [30, 20, 10, 0];
    const results = await mapWithConcurrency(items, 4, (ms, i) => delay(ms).then(() => `${i}:${ms}`));
    expect(results).toEqual(["0:30", "1:20", "2:10", "3:0"]);
  });

  it("runs serially when the limit is 1 (default behavior)", async () => {
    const events: string[] = [];
    const results = await mapWithConcurrency([1, 2, 3], 1, async (n) => {
      events.push(`start-${n}`);
      await delay(0);
      events.push(`end-${n}`);
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30]);
    // Strictly serial: each job fully ends before the next starts.
    expect(events).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
  });

  it("caps the number of in-flight workers", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(1);
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  it("returns an empty array for no items without invoking the worker", async () => {
    let called = false;
    const results = await mapWithConcurrency([], 4, async () => {
      called = true;
      return 1;
    });
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });

  it("processes every item even when there are fewer than the limit", async () => {
    const results = await mapWithConcurrency([1, 2], 8, async (n) => n + 1);
    expect(results).toEqual([2, 3]);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
