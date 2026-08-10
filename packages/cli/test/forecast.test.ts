import type { JobForecast, QueueForecast } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { CAUGHT_UP_MESSAGE, renderForecast, renderForecastJson } from "../src/forecast.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

function caughtUp(): QueueForecast {
  return {
    waiting: 0,
    maxConcurrent: 2,
    jobDurationMs: MIN,
    entries: [],
    firstResetAt: null,
    lastResetAt: null,
    drainMs: null,
    drainAt: null,
    naiveEtaMs: null,
    contentionMs: null,
    maxQueuedMs: 0,
    caughtUp: true,
  };
}

function entry(overrides: Partial<JobForecast> = {}): JobForecast {
  return {
    jobId: "job-1234abcd",
    project: "alpha",
    resetAt: "2026-07-30T12:00:00.000Z",
    readyMs: 2 * HOUR,
    startMs: 2 * HOUR,
    finishMs: 2 * HOUR + 30 * MIN,
    slot: 0,
    queuedMs: 0,
    ...overrides,
  };
}

function forecast(overrides: Partial<QueueForecast> = {}): QueueForecast {
  return {
    waiting: 3,
    maxConcurrent: 1,
    jobDurationMs: 30 * MIN,
    entries: [
      entry({ jobId: "aaaaaaaa-1", startMs: 2 * HOUR, finishMs: 2 * HOUR + 30 * MIN }),
      entry({ jobId: "bbbbbbbb-2", startMs: 2 * HOUR + 30 * MIN, finishMs: 3 * HOUR, queuedMs: 30 * MIN }),
      entry({ jobId: "cccccccc-3", startMs: 3 * HOUR, finishMs: 3 * HOUR + 30 * MIN, queuedMs: HOUR }),
    ],
    firstResetAt: "2026-07-30T12:00:00.000Z",
    lastResetAt: "2026-07-30T12:00:00.000Z",
    drainMs: 3 * HOUR + 30 * MIN,
    drainAt: "2026-07-30T13:30:00.000Z",
    naiveEtaMs: 2 * HOUR,
    contentionMs: HOUR,
    maxQueuedMs: HOUR,
    caughtUp: false,
    ...overrides,
  };
}

describe("renderForecast", () => {
  it("shows the caught-up message when nothing is waiting", () => {
    expect(renderForecast(caughtUp())).toBe(CAUGHT_UP_MESSAGE);
  });

  it("reports the drain countdown, the assumptions, and the contention note", () => {
    const out = renderForecast(forecast(), { durationSource: "history" });
    expect(out).toContain("Backlog drains in 3h 30m");
    expect(out).toContain("3 jobs waiting");
    expect(out).toContain("1× concurrency");
    expect(out).toContain("~30m 0s/resume (median of past resolutions)");
    expect(out).toContain("+1h 0m of contention");
  });

  it("labels the duration source from the flag", () => {
    const out = renderForecast(forecast(), { durationSource: "flag" });
    expect(out).toContain("(from --duration)");
  });

  it("omits the contention note when there is none", () => {
    const out = renderForecast(forecast({ contentionMs: 0, maxQueuedMs: 0 }));
    expect(out).not.toContain("contention");
  });

  it("renders per-job rows with slot-wait annotations", () => {
    const out = renderForecast(forecast());
    expect(out).toContain("bbbbbbbb"); // short id (8 chars)
    expect(out).toContain("waits 30m 0s for a slot");
    expect(out).toContain("[alpha]");
  });

  it("trims the timeline to the limit and notes the remainder", () => {
    const out = renderForecast(forecast(), { limit: 1 });
    expect(out).toContain("aaaaaaaa");
    expect(out).not.toContain("cccccccc");
    expect(out).toContain("… 2 more.");
  });

  it("phrases an already-drained queue rather than a negative countdown", () => {
    const out = renderForecast(forecast({ drainMs: -1000, entries: [] }));
    expect(out).toContain("now (already drained)");
    expect(out).not.toContain("drains in -");
  });

  it("emits no ANSI codes when color is off", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderForecast(forecast(), { color: false })).not.toMatch(/\x1b\[/);
  });
});

describe("renderForecastJson", () => {
  it("produces valid JSON with the envelope and caught-up forecast", () => {
    const parsed = JSON.parse(
      renderForecastJson(caughtUp(), "/tmp/store.json", { generatedAt: "2026-07-30T10:00:00.000Z" })
    );
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.durationSource).toBe("default");
    expect(parsed.forecast.caughtUp).toBe(true);
    expect(parsed.forecast.drainAt).toBeNull();
  });

  it("carries the full forecast shape and the duration source", () => {
    const parsed = JSON.parse(renderForecastJson(forecast(), "/tmp/store.json", { durationSource: "history" }));
    expect(parsed.durationSource).toBe("history");
    expect(parsed.forecast.waiting).toBe(3);
    expect(parsed.forecast.drainMs).toBe(3 * HOUR + 30 * MIN);
    expect(parsed.forecast.contentionMs).toBe(HOUR);
    expect(parsed.forecast.entries).toHaveLength(3);
  });
});
