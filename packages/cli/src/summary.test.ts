import type { QueueSummary, RelayJob } from "@agentrelay/core";
import { summarizeJobs } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { EMPTY_MESSAGE, renderSummary, renderSummaryJson, renderSummaryWatchFrame } from "./summary.js";

/** Zero-filled QueueSummary with the given overrides — mirrors summarizeJobs' shape. */
function summary(overrides: Partial<QueueSummary> = {}): QueueSummary {
  return {
    total: 0,
    byStatus: {
      queued: 0,
      waiting_for_reset: 0,
      resuming: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    },
    nextResetAt: null,
    ...overrides,
  };
}

// A fixed "now" so countdown assertions are deterministic.
const NOW = Date.parse("2026-08-10T12:00:00.000Z");

describe("renderSummary", () => {
  it("shows the empty-store hint when there are no jobs", () => {
    expect(renderSummary(summary(), { now: NOW })).toBe(EMPTY_MESSAGE);
  });

  it("pluralizes the job count and reports nothing waiting when no reset is pending", () => {
    const out = renderSummary(summary({ total: 1, byStatus: { ...summary().byStatus, completed: 1 } }), {
      now: NOW,
    });
    expect(out).toContain("1 job");
    expect(out).not.toContain("1 jobs");
    expect(out).toContain("nothing waiting for a reset");
    expect(out).toContain("completed 1");
  });

  it("renders the next-reset countdown from the earliest reset time", () => {
    const resetAt = new Date(NOW + 63 * 60_000).toISOString(); // 1h 3m out
    const out = renderSummary(
      summary({
        total: 4,
        byStatus: { ...summary().byStatus, waiting_for_reset: 2, completed: 2 },
        nextResetAt: resetAt,
      }),
      { now: NOW }
    );
    expect(out).toContain("4 jobs");
    expect(out).toContain("next reset in 1h 3m");
    expect(out).toContain(resetAt);
    expect(out).toContain("waiting_for_reset 2");
    expect(out).toContain("completed 2");
  });

  it("omits zero-count statuses from the breakdown for scannability", () => {
    const out = renderSummary(summary({ total: 1, byStatus: { ...summary().byStatus, queued: 1 } }), {
      now: NOW,
    });
    expect(out).toContain("queued 1");
    expect(out).not.toContain("failed 0");
    expect(out).not.toContain("cancelled 0");
  });

  it("emits ANSI color only when color is enabled", () => {
    const s = summary({ total: 1, byStatus: { ...summary().byStatus, failed: 1 } });
    expect(renderSummary(s, { now: NOW, color: false })).not.toContain("\x1b[");
    expect(renderSummary(s, { now: NOW, color: true })).toContain("\x1b[");
  });

  it("matches summarizeJobs output end-to-end", () => {
    const jobs: RelayJob[] = [
      makeJob({ status: "waiting_for_reset", resetAt: new Date(NOW + 30 * 60_000).toISOString() }),
      makeJob({ status: "completed" }),
    ];
    const out = renderSummary(summarizeJobs(jobs), { now: NOW });
    expect(out).toContain("2 jobs");
    expect(out).toContain("next reset in 30m");
    expect(out).toContain("waiting_for_reset 1");
    expect(out).toContain("completed 1");
  });
});

describe("renderSummaryWatchFrame", () => {
  it("wraps the overview in a live banner with the interval, timestamp, and store path", () => {
    const s = summary({
      total: 2,
      byStatus: { ...summary().byStatus, waiting_for_reset: 1, completed: 1 },
      nextResetAt: new Date(NOW + 63 * 60_000).toISOString(),
    });
    const frame = renderSummaryWatchFrame(s, "/x/jobs.json", 2000, NOW);
    expect(frame).toContain("agentrelay summary");
    expect(frame).toContain("live, every 2s");
    expect(frame).toContain("Ctrl-C to exit");
    expect(frame).toContain("2026-08-10 12:00:00Z");
    expect(frame).toContain("/x/jobs.json");
    // Body: always colored (so the countdown is bolded away from its label),
    // with the live countdown from `now`.
    expect(frame).toContain("2 jobs");
    expect(frame).toContain("next reset in");
    expect(frame).toContain("1h 3m");
    expect(frame).toContain("\x1b[");
  });

  it("echoes the scope note under the banner when a filter is active", () => {
    const s = summary({ total: 1, byStatus: { ...summary().byStatus, queued: 1 } });
    const frame = renderSummaryWatchFrame(s, "/x/jobs.json", 5000, NOW, "project=web");
    expect(frame).toContain("scope: project=web");
    expect(frame).toContain("live, every 5s");
  });

  it("omits the scope line when no filter is active", () => {
    const s = summary({ total: 1, byStatus: { ...summary().byStatus, queued: 1 } });
    const frame = renderSummaryWatchFrame(s, "/x/jobs.json", 2000, NOW);
    expect(frame).not.toContain("scope:");
  });
});

describe("renderSummaryJson", () => {
  it("carries the full summary plus provenance, with every status zero-filled", () => {
    const s = summary({ total: 2, byStatus: { ...summary().byStatus, queued: 1, completed: 1 } });
    const parsed = JSON.parse(renderSummaryJson(s, "/x/jobs.json", "2026-08-10T12:00:00.000Z"));
    expect(parsed.storePath).toBe("/x/jobs.json");
    expect(parsed.generatedAt).toBe("2026-08-10T12:00:00.000Z");
    expect(parsed.summary.total).toBe(2);
    expect(parsed.summary.byStatus).toMatchObject({ queued: 1, completed: 1, failed: 0, cancelled: 0 });
    expect(parsed.summary.nextResetAt).toBeNull();
  });
});

/** Minimal RelayJob for the end-to-end summarizeJobs test. */
function makeJob(overrides: Partial<RelayJob>): RelayJob {
  return {
    id: "job-0000",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/work",
    status: "queued",
    resetAt: null,
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
    attempts: 0,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}
