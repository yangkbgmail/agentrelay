import type { RateLimitDetection, RateLimitWindowSummary, RelayJob } from "@agentrelay/core";
import { summarizeRateLimitWindows } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_WINDOW_DATA_MESSAGE, NO_WINDOWS_MESSAGE, renderWindows, renderWindowsJson } from "../src/windows.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "proj",
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

function detection(hours: number, overrides: Partial<RateLimitDetection> = {}): RateLimitDetection {
  const detectedAt = "2026-07-13T00:00:00.000Z";
  const resetAt = new Date(Date.parse(detectedAt) + hours * 3_600_000).toISOString();
  return { pattern: "clock-time", rawMatch: "resets at 5pm", detectedAt, resetAt, ...overrides };
}

function summaryOf(jobs: RelayJob[]): RateLimitWindowSummary {
  return summarizeRateLimitWindows(jobs);
}

describe("renderWindows", () => {
  it("shows the no-windows message on an empty store", () => {
    expect(renderWindows(summaryOf([]))).toContain(NO_WINDOWS_MESSAGE);
  });

  it("switches to the no-match message when a scope is active", () => {
    const out = renderWindows(summaryOf([]), { scopeNote: "status=waiting_for_reset" });
    expect(out).toContain("No jobs match the current filter.");
    expect(out).toContain("scope: status=waiting_for_reset");
  });

  it("shows the no-data message when jobs exist but none have a window", () => {
    const out = renderWindows(summaryOf([job({}), job({})]));
    expect(out).toContain(NO_WINDOW_DATA_MESSAGE);
    expect(out).toContain("2 job(s) tracked");
  });

  it("renders the headline total, distribution, patterns, and longest windows", () => {
    const out = renderWindows(
      summaryOf([
        job({ id: "aaaa1111", lastRateLimit: detection(1, { pattern: "clock-time" }) }),
        job({ id: "bbbb2222", lastRateLimit: detection(5, { pattern: "relative-duration" }) }),
      ])
    );
    // 1h + 5h = 6h total wait across 2 windows.
    expect(out).toContain("6h 0m total rate-limit wait across 2 window(s)");
    expect(out).toContain("avg 3h 0m");
    expect(out).toContain("By pattern (total wait):");
    expect(out).toContain("relative-duration");
    expect(out).toContain("Longest windows:");
    // Longest window (5h, relative-duration) sorts first, id truncated to 8 chars.
    expect(out.indexOf("bbbb2222")).toBeLessThan(out.indexOf("aaaa1111"));
  });

  it("emits no ANSI escapes when color is off", () => {
    const out = renderWindows(summaryOf([job({ lastRateLimit: detection(2) })]), { color: false });
    expect(out).not.toContain("\x1b[");
  });

  it("round-trips the JSON envelope with the summary intact", () => {
    const summary = summaryOf([job({ lastRateLimit: detection(3) })]);
    const json = renderWindowsJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-13T01:00:00.000Z",
      scope: { statuses: ["waiting_for_reset"] },
      summary,
    });
    const parsed = JSON.parse(json);
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.scope).toEqual({ statuses: ["waiting_for_reset"] });
    expect(parsed.summary.totalWaitMs).toBe(3 * 3_600_000);
    expect(parsed.summary.withWindow).toBe(1);
  });
});
