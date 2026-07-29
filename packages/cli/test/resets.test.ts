import type { RelayJob } from "@agentrelay/core";
import { computeResetClock } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  NO_JOBS_MESSAGE,
  NO_RESETS_MESSAGE,
  NO_SCOPE_MATCH_MESSAGE,
  renderResetClock,
  renderResetClockJson,
} from "../src/resets.js";

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

describe("renderResetClock", () => {
  it("shows the onboarding message for an empty store", () => {
    const out = renderResetClock(computeResetClock([]));
    expect(out).toContain(NO_JOBS_MESSAGE);
  });

  it("shows the scope-match message when a filter empties the store", () => {
    const out = renderResetClock(computeResetClock([]), { scopeNote: "status=failed" });
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
    expect(out).toContain("scope: status=failed");
  });

  it("shows the no-resets message when jobs exist but none have a reset", () => {
    const summary = computeResetClock([job({ resetAt: null, lastRateLimit: null })]);
    const out = renderResetClock(summary);
    expect(out).toContain(NO_RESETS_MESSAGE);
    expect(out).toContain("1 job(s) tracked");
  });

  it("renders all 24 hours, a bar for populated ones, and the peak footer", () => {
    const summary = computeResetClock([
      job({ resetAt: "2026-07-13T05:00:00.000Z" }),
      job({ resetAt: "2026-07-13T05:30:00.000Z" }),
      job({ resetAt: "2026-07-13T14:00:00.000Z" }),
    ]);
    const out = renderResetClock(summary);
    // Header calls out the count and timezone.
    expect(out).toContain("3 reset(s) by hour of day (UTC)");
    // Every hour label 00:00..23:00 is present.
    for (let h = 0; h < 24; h++) {
      expect(out).toContain(`${String(h).padStart(2, "0")}:00`);
    }
    // Busiest hour (05:00, 2 resets) is the tallest bar and the peak.
    expect(out).toContain("█");
    expect(out).toContain("peak: 05:00 UTC");
  });

  it("labels the timezone as local time when the summary is local", () => {
    const summary = computeResetClock([job({ resetAt: "2026-07-13T05:00:00.000Z" })], { local: true });
    const out = renderResetClock(summary);
    expect(out).toContain("by hour of day (local time)");
    expect(out).toContain("peak:");
    expect(out).toContain("local time");
  });
});

describe("renderResetClockJson", () => {
  it("emits the store path, scope, and full summary as parseable JSON", () => {
    const summary = computeResetClock([job({ resetAt: "2026-07-13T09:00:00.000Z" })]);
    const json = renderResetClockJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-13T00:00:00.000Z",
      scope: { statuses: ["waiting_for_reset"] },
      summary,
    });
    const parsed = JSON.parse(json);
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-13T00:00:00.000Z");
    expect(parsed.scope).toEqual({ statuses: ["waiting_for_reset"] });
    expect(parsed.summary.withReset).toBe(1);
    expect(parsed.summary.buckets).toHaveLength(24);
    expect(parsed.summary.peakHour).toBe(9);
  });
});
