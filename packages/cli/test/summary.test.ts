import type { QueueSummary } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  computeSummarySegments,
  EMPTY_SUMMARY,
  hasPendingWork,
  renderSummary,
  renderSummaryJson,
} from "../src/summary.js";

const NOW = Date.parse("2026-07-13T00:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function summary(overrides: Partial<QueueSummary["byStatus"]> = {}, nextResetAt: string | null = null): QueueSummary {
  const byStatus = {
    queued: 0,
    waiting_for_reset: 0,
    resuming: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    ...overrides,
  };
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return { total, byStatus, nextResetAt };
}

describe("computeSummarySegments", () => {
  it("folds queued + resuming into 'active' and keeps a fixed display order", () => {
    const segs = computeSummarySegments(summary({ queued: 2, resuming: 1, waiting_for_reset: 3, completed: 4 }));
    expect(segs.map((s) => s.key)).toEqual(["waiting", "active", "done", "failed", "cancelled"]);
    expect(segs.find((s) => s.key === "active")?.count).toBe(3); // 2 queued + 1 resuming
    expect(segs.find((s) => s.key === "waiting")?.count).toBe(3);
    expect(segs.find((s) => s.key === "done")?.count).toBe(4);
  });
});

describe("hasPendingWork", () => {
  it("is true when jobs are queued, resuming, or waiting for a reset", () => {
    expect(hasPendingWork(summary({ waiting_for_reset: 1 }))).toBe(true);
    expect(hasPendingWork(summary({ queued: 1 }))).toBe(true);
    expect(hasPendingWork(summary({ resuming: 1 }))).toBe(true);
  });

  it("is false when every job is terminal or the queue is empty", () => {
    expect(hasPendingWork(summary({ completed: 3, failed: 1, cancelled: 2 }))).toBe(false);
    expect(hasPendingWork(summary())).toBe(false);
  });
});

describe("renderSummary", () => {
  it("shows the empty message for an empty store", () => {
    expect(renderSummary(summary(), { now: NOW })).toBe(EMPTY_SUMMARY);
  });

  it("shows only non-zero buckets, joined by ' · '", () => {
    const out = renderSummary(summary({ completed: 5, failed: 1 }), { now: NOW });
    expect(out).toBe("5 done · 1 failed");
    expect(out).not.toContain("waiting");
    expect(out).not.toContain("active");
  });

  it("appends the next-reset countdown when a job is waiting", () => {
    const out = renderSummary(summary({ waiting_for_reset: 2, completed: 1 }, at(90 * 60_000)), { now: NOW });
    expect(out).toContain("2 waiting");
    expect(out).toContain("1 done");
    expect(out).toContain("next reset in 1h 30m");
  });

  it("says 'next reset due now' once the reset time has passed", () => {
    const out = renderSummary(summary({ waiting_for_reset: 1 }, at(-1000)), { now: NOW });
    expect(out).toContain("next reset due now");
    expect(out).not.toContain("next reset in");
  });

  it("omits the countdown when nothing is waiting even if nextResetAt is stale", () => {
    const out = renderSummary(summary({ completed: 2 }, at(60_000)), { now: NOW });
    expect(out).not.toContain("next reset");
  });

  it("emits no ANSI codes when color is off", () => {
    const out = renderSummary(summary({ waiting_for_reset: 1, failed: 2 }, at(60_000)), { now: NOW, color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("emits ANSI codes when color is on", () => {
    const out = renderSummary(summary({ completed: 1 }), { now: NOW, color: true });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI escapes are present.
    expect(out).toMatch(/\x1b\[/);
  });
});

describe("renderSummaryJson", () => {
  it("wraps the summary with storePath, generatedAt, and a pending flag", () => {
    const parsed = JSON.parse(
      renderSummaryJson(
        summary({ waiting_for_reset: 1, completed: 2 }, at(0)),
        "/tmp/store.json",
        "2026-07-13T00:00:00.000Z"
      )
    );
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-13T00:00:00.000Z");
    expect(parsed.pending).toBe(true);
    expect(parsed.summary.total).toBe(3);
    expect(parsed.summary.byStatus.waiting_for_reset).toBe(1);
  });

  it("reports pending=false for an all-terminal queue", () => {
    const parsed = JSON.parse(renderSummaryJson(summary({ completed: 4 }), "/tmp/store.json"));
    expect(parsed.pending).toBe(false);
  });
});
