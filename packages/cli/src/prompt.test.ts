import type { QueueSummary } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { promptCounts, renderPrompt, renderPromptJson } from "./prompt.js";

/** Build a QueueSummary from partial per-status counts (rest zero-filled). */
function summary(counts: Partial<QueueSummary["byStatus"]>, nextResetAt: string | null = null): QueueSummary {
  const byStatus = {
    queued: 0,
    waiting_for_reset: 0,
    resuming: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    ...counts,
  };
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return { total, byStatus, nextResetAt };
}

// A fixed "now" so countdowns are deterministic.
const NOW = Date.parse("2026-08-11T12:00:00.000Z");
const IN_1H_3M = new Date(NOW + 63 * 60 * 1000).toISOString(); // exactly 63 min → "1h 3m"

describe("promptCounts", () => {
  it("splits waiting vs in-flight and sums pending", () => {
    const c = promptCounts(summary({ waiting_for_reset: 3, queued: 1, resuming: 2, completed: 9 }));
    expect(c).toEqual({ waiting: 3, running: 3, pending: 6 });
  });

  it("excludes terminal states from pending", () => {
    const c = promptCounts(summary({ completed: 5, failed: 2, cancelled: 1 }));
    expect(c).toEqual({ waiting: 0, running: 0, pending: 0 });
  });
});

describe("renderPrompt", () => {
  it("renders empty string when nothing is pending", () => {
    expect(renderPrompt(summary({ completed: 4 }), { now: NOW })).toBe("");
  });

  it("emits an idle marker with --zero when nothing is pending", () => {
    expect(renderPrompt(summary({ completed: 4 }), { now: NOW, zero: true })).toBe("✓");
    expect(renderPrompt(summary({}), { now: NOW, zero: true, plain: true })).toBe("ok");
  });

  it("shows the waiting count with a glyph and the next-reset countdown", () => {
    const out = renderPrompt(summary({ waiting_for_reset: 3 }, IN_1H_3M), { now: NOW });
    expect(out).toBe("⏳3 (1h 3m)");
  });

  it("shows both waiting and in-flight counts, queued folded into running", () => {
    const out = renderPrompt(summary({ waiting_for_reset: 2, queued: 1, resuming: 1 }, IN_1H_3M), { now: NOW });
    expect(out).toBe("⏳2 ▶2 (1h 3m)");
  });

  it("omits the countdown when nothing is waiting for a reset", () => {
    const out = renderPrompt(summary({ resuming: 1 }), { now: NOW });
    expect(out).toBe("▶1");
  });

  it("renders 'due now' when the reset is in the past", () => {
    const past = new Date(NOW - 60_000).toISOString();
    const out = renderPrompt(summary({ waiting_for_reset: 1 }, past), { now: NOW });
    expect(out).toBe("⏳1 (due now)");
  });

  it("uses ASCII labels in --plain mode", () => {
    const out = renderPrompt(summary({ waiting_for_reset: 3, resuming: 1 }, IN_1H_3M), { now: NOW, plain: true });
    expect(out).toBe("wait:3 run:1 (1h 3m)");
  });

  it("emits no ANSI by default even with pending work", () => {
    const out = renderPrompt(summary({ waiting_for_reset: 1 }, IN_1H_3M), { now: NOW });
    expect(out).not.toContain("\x1b[");
  });

  it("emits ANSI only when color is opted in", () => {
    const out = renderPrompt(summary({ waiting_for_reset: 1 }, IN_1H_3M), { now: NOW, color: true });
    expect(out).toContain("\x1b[33m"); // yellow for waiting
    expect(out).toContain("\x1b[0m");
  });
});

describe("renderPromptJson", () => {
  it("carries split counts, ISO reset, a pre-rendered countdown, and provenance", () => {
    const json = JSON.parse(
      renderPromptJson(summary({ waiting_for_reset: 3, queued: 1 }, IN_1H_3M), "/tmp/jobs.json", {
        now: NOW,
        generatedAt: "2026-08-11T12:00:00.000Z",
      })
    );
    expect(json).toMatchObject({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-08-11T12:00:00.000Z",
      waiting: 3,
      running: 1,
      pending: 4,
      nextResetAt: IN_1H_3M,
      nextResetCountdown: "1h 3m",
    });
    expect(json.byStatus.waiting_for_reset).toBe(3);
  });

  it("nulls the countdown when nothing is waiting", () => {
    const json = JSON.parse(renderPromptJson(summary({ completed: 2 }), "/tmp/jobs.json", { now: NOW }));
    expect(json.nextResetAt).toBeNull();
    expect(json.nextResetCountdown).toBeNull();
    expect(json.pending).toBe(0);
  });
});
