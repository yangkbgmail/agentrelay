import type { QueueSummary } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { BASE_TITLE, buildPageTitle } from "../lib/title";

/** Build a QueueSummary with a fully zero-filled byStatus, then apply overrides. */
function summary(overrides: Partial<QueueSummary["byStatus"]> = {}, extra: Partial<QueueSummary> = {}): QueueSummary {
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
  return { total, byStatus, nextResetAt: null, ...extra };
}

describe("buildPageTitle", () => {
  it("returns the base title when there is no summary yet (initial load)", () => {
    expect(buildPageTitle(undefined)).toBe(BASE_TITLE);
    expect(buildPageTitle(null)).toBe(BASE_TITLE);
  });

  it("returns the base title for an empty queue", () => {
    expect(buildPageTitle(summary())).toBe(BASE_TITLE);
  });

  it("badges the count of jobs waiting for reset", () => {
    expect(buildPageTitle(summary({ waiting_for_reset: 3 }))).toBe("(3) AgentRelay Dashboard");
  });

  it("badges resuming jobs", () => {
    expect(buildPageTitle(summary({ resuming: 2 }))).toBe("(2) AgentRelay Dashboard");
  });

  it("sums resuming and waiting into one in-flight badge", () => {
    expect(buildPageTitle(summary({ resuming: 2, waiting_for_reset: 3 }))).toBe("(5) AgentRelay Dashboard");
  });

  it("ignores terminal states — completed/failed/cancelled never enter the badge", () => {
    expect(buildPageTitle(summary({ completed: 10, failed: 4, cancelled: 2 }))).toBe(BASE_TITLE);
  });

  it("ignores queued jobs (not yet parked on a reset) in the badge", () => {
    // `queued` is a transient pre-detection state; the badge tracks jobs the
    // relay is actively juggling (resuming + waiting_for_reset).
    expect(buildPageTitle(summary({ queued: 5 }))).toBe(BASE_TITLE);
  });

  it("counts only in-flight jobs when terminal jobs are also present", () => {
    expect(buildPageTitle(summary({ resuming: 1, waiting_for_reset: 1, completed: 8, failed: 3 }))).toBe(
      "(2) AgentRelay Dashboard"
    );
  });

  it("is defensive against a partial byStatus (missing keys count as 0)", () => {
    const partial = { total: 1, byStatus: { resuming: 1 }, nextResetAt: null } as unknown as QueueSummary;
    expect(buildPageTitle(partial)).toBe("(1) AgentRelay Dashboard");
  });
});
