import type { LeadTimeSummary } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  NO_DETECTIONS_MESSAGE,
  NO_SCOPE_MATCH_MESSAGE,
  NO_WINDOWS_MESSAGE,
  renderWindows,
  renderWindowsJson,
} from "./windows.js";

const HOUR = 60 * 60 * 1000;

/** A LeadTimeSummary with sensible zeros, overridable per test. */
function summary(overrides: Partial<LeadTimeSummary> = {}): LeadTimeSummary {
  return {
    total: 0,
    withDetection: 0,
    withoutDetection: 0,
    count: 0,
    skipped: 0,
    avgMs: null,
    minMs: null,
    maxMs: null,
    medianMs: null,
    p90Ms: null,
    byPattern: [],
    ...overrides,
  };
}

describe("renderWindows", () => {
  it("shows the empty-store hint when there are no jobs", () => {
    expect(renderWindows(summary())).toBe(NO_WINDOWS_MESSAGE);
  });

  it("shows the no-match hint when a scope filters everything out", () => {
    const out = renderWindows(summary(), { scopeNote: "tool=codex-cli" });
    expect(out).toContain("scope: tool=codex-cli");
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
  });

  it("shows the no-detections hint when jobs exist but none carry a window", () => {
    const out = renderWindows(summary({ total: 3, withoutDetection: 3 }));
    expect(out).toContain(NO_DETECTIONS_MESSAGE);
    expect(out).toContain("3 job(s) tracked, 0 with a recorded rate-limit detection");
  });

  it("notes when detections exist but none produced a usable window", () => {
    const out = renderWindows(summary({ total: 2, withDetection: 2, withoutDetection: 0, skipped: 2 }));
    expect(out).toContain(NO_DETECTIONS_MESSAGE);
    expect(out).toContain("2 detection(s) but none with a usable window (2 skipped)");
  });

  it("renders the distribution line with formatted durations", () => {
    const out = renderWindows(
      summary({
        total: 5,
        withDetection: 5,
        count: 5,
        minMs: 1 * HOUR,
        medianMs: 3 * HOUR,
        avgMs: 3 * HOUR,
        p90Ms: Math.round(4.6 * HOUR),
        maxMs: 5 * HOUR,
      })
    );
    expect(out).toContain("reset window (lead time) across 5 detection(s)");
    expect(out).toContain("min 1h 0m");
    expect(out).toContain("median 3h 0m");
    expect(out).toContain("max 5h 0m");
  });

  it("echoes skipped detections in the header when some were unusable", () => {
    const out = renderWindows(
      summary({
        total: 4,
        withDetection: 4,
        withoutDetection: 0,
        count: 3,
        skipped: 1,
        minMs: HOUR,
        medianMs: HOUR,
        avgMs: HOUR,
        p90Ms: HOUR,
        maxMs: HOUR,
      })
    );
    expect(out).toContain("1 skipped");
  });

  it("renders a per-pattern breakdown ranked as given", () => {
    const out = renderWindows(
      summary({
        total: 4,
        withDetection: 4,
        count: 4,
        minMs: HOUR,
        medianMs: 4 * HOUR,
        avgMs: 3 * HOUR,
        p90Ms: 5 * HOUR,
        maxMs: 5 * HOUR,
        byPattern: [
          { pattern: "five-hour-window-fallback", count: 2, avgMs: 5 * HOUR, minMs: 5 * HOUR, maxMs: 5 * HOUR },
          { pattern: "relative-duration", count: 2, avgMs: 2 * HOUR, minMs: HOUR, maxMs: 3 * HOUR },
        ],
      })
    );
    expect(out).toContain("by pattern");
    expect(out).toContain("five-hour-window-fallback");
    expect(out).toContain("relative-duration");
    // The range annotation shows the min–max span for a pattern.
    expect(out).toContain("[1h 0m – 3h 0m]");
  });

  it("emits ANSI codes only when color is on", () => {
    const plain = renderWindows(
      summary({ total: 1, withDetection: 1, count: 1, minMs: 0, medianMs: 0, avgMs: 0, p90Ms: 0, maxMs: 0 }),
      { color: false }
    );
    const colored = renderWindows(
      summary({ total: 1, withDetection: 1, count: 1, minMs: 0, medianMs: 0, avgMs: 0, p90Ms: 0, maxMs: 0 }),
      { color: true }
    );
    expect(plain).not.toContain("\x1b[");
    expect(colored).toContain("\x1b[");
  });
});

describe("renderWindowsJson", () => {
  it("wraps the summary in the standard envelope", () => {
    const s = summary({
      total: 1,
      withDetection: 1,
      count: 1,
      minMs: HOUR,
      medianMs: HOUR,
      avgMs: HOUR,
      p90Ms: HOUR,
      maxMs: HOUR,
    });
    const json = renderWindowsJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-08-15T00:00:00.000Z",
      scope: { tools: ["claude-code"] },
      summary: s,
    });
    const parsed = JSON.parse(json);
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-08-15T00:00:00.000Z");
    expect(parsed.scope).toEqual({ tools: ["claude-code"] });
    expect(parsed.summary.count).toBe(1);
    expect(parsed.summary.medianMs).toBe(HOUR);
  });
});
