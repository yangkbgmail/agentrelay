import type { RelayJob } from "@agentrelay/core";
import { computeHourlyActivity } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  formatOffsetLabel,
  NO_HEATMAP_MESSAGE,
  NO_SCOPE_MATCH_MESSAGE,
  renderHeatmap,
  renderHeatmapJson,
} from "../src/heatmap.js";

let seq = 0;
function job(createdAt: string, overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `abcdef${seq}`,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "completed",
    resetAt: null,
    createdAt,
    updatedAt: createdAt,
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("formatOffsetLabel", () => {
  it("labels UTC and offsets", () => {
    expect(formatOffsetLabel(0)).toBe("UTC");
    expect(formatOffsetLabel(540)).toBe("UTC+09:00");
    expect(formatOffsetLabel(-420)).toBe("UTC-07:00");
    expect(formatOffsetLabel(330)).toBe("UTC+05:30");
  });
});

describe("renderHeatmap", () => {
  it("shows the onboarding message for an empty store", () => {
    expect(renderHeatmap(computeHourlyActivity([]))).toBe(NO_HEATMAP_MESSAGE);
  });

  it("shows the no-match message for an empty scoped subset", () => {
    const out = renderHeatmap(computeHourlyActivity([]), { scopeNote: "project=web" });
    expect(out).toContain("scope: project=web");
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
  });

  it("renders 24 hour rows with a peak marker and footer", () => {
    const activity = computeHourlyActivity([
      job("2026-07-13T09:00:00.000Z"),
      job("2026-07-14T09:30:00.000Z"),
      job("2026-07-13T15:00:00.000Z"),
    ]);
    const out = renderHeatmap(activity);
    expect(out).toContain("activity by hour of day");
    expect(out).toContain("(jobs created, UTC)");
    expect(out).toContain("00:00");
    expect(out).toContain("23:00");
    expect(out).toContain("09:00");
    // The 09:00 row is the peak (2 jobs) and carries the marker.
    const peakRow = out.split("\n").find((l) => l.includes("09:00"));
    expect(peakRow).toContain("← peak");
    expect(peakRow).toContain("█");
    expect(out).toContain("busiest 09:00 (2)");
  });

  it("reports skipped jobs in the footer and totals", () => {
    const activity = computeHourlyActivity([job("2026-07-13T09:00:00.000Z"), job("bogus")]);
    const out = renderHeatmap(activity);
    expect(out).toContain("1 skipped (no timestamp)");
  });

  it("says so plainly when no job has a usable timestamp", () => {
    const activity = computeHourlyActivity([job("nope"), job("also-nope")]);
    const out = renderHeatmap(activity);
    expect(out).toContain("no jobs with a usable timestamp (2 skipped)");
    expect(out).not.toContain("← peak");
  });

  it("labels the header with a non-UTC offset", () => {
    const activity = computeHourlyActivity([job("2026-07-13T22:30:00.000Z")], { offsetMinutes: 540 });
    const out = renderHeatmap(activity);
    expect(out).toContain("(jobs created, UTC+09:00)");
    // 22:30 UTC + 9h = 07:30 → the 07:00 bucket is the peak.
    expect(out).toContain("busiest 07:00 (1)");
  });
});

describe("renderHeatmapJson", () => {
  it("emits the standard envelope with the full activity payload", () => {
    const activity = computeHourlyActivity([job("2026-07-13T09:00:00.000Z")]);
    const json = renderHeatmapJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-13T12:00:00.000Z",
      activity,
    });
    const parsed = JSON.parse(json);
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-13T12:00:00.000Z");
    expect(parsed.scope).toBeUndefined();
    expect(parsed.activity.hours).toHaveLength(24);
    expect(parsed.activity.hours[9].count).toBe(1);
    expect(parsed.activity.peakHour).toBe(9);
  });
});
