import type { RateLimitDetection, RelayJob } from "@agentrelay/core";
import { hourlyRateLimitDistribution } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  formatOffsetLabel,
  NO_DETECTIONS_MESSAGE,
  NO_SCOPE_MATCH_MESSAGE,
  NO_WHEN_MESSAGE,
  renderWhen,
  renderWhenJson,
} from "../src/when.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `abcdef${seq}`,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "waiting_for_reset",
    resetAt: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function detection(overrides: Partial<RateLimitDetection> = {}): RateLimitDetection {
  return {
    pattern: "clock-time",
    rawMatch: "resets at 5:30pm",
    resetAt: "2026-07-12T17:30:00.000Z",
    detectedAt: "2026-07-12T09:00:00.000Z",
    ...overrides,
  };
}

describe("formatOffsetLabel", () => {
  it("renders UTC for a zero (or non-finite) offset", () => {
    expect(formatOffsetLabel(0)).toBe("UTC");
    expect(formatOffsetLabel(Number.NaN)).toBe("UTC");
  });

  it("renders signed HH:MM offsets, including fractional zones", () => {
    expect(formatOffsetLabel(9 * 60)).toBe("UTC+09:00");
    expect(formatOffsetLabel(-8 * 60)).toBe("UTC-08:00");
    expect(formatOffsetLabel(330)).toBe("UTC+05:30");
  });
});

describe("renderWhen", () => {
  it("shows the onboarding message for an empty store", () => {
    expect(renderWhen(hourlyRateLimitDistribution([]))).toBe(NO_WHEN_MESSAGE);
  });

  it("shows the no-match message for an empty scoped subset", () => {
    const out = renderWhen(hourlyRateLimitDistribution([]), { scopeNote: "tool=codex-cli" });
    expect(out).toContain("scope: tool=codex-cli");
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
  });

  it("shows a distinct message when jobs exist but none have a detection", () => {
    const out = renderWhen(hourlyRateLimitDistribution([job(), job()]));
    expect(out).toContain(NO_DETECTIONS_MESSAGE);
    expect(out).toContain("2 job(s) tracked");
  });

  it("renders a 24-row histogram with a peak marker and offset label", () => {
    const out = renderWhen(
      hourlyRateLimitDistribution(
        [
          job({ lastRateLimit: detection({ detectedAt: "2026-07-12T09:00:00.000Z" }) }),
          job({ lastRateLimit: detection({ detectedAt: "2026-07-12T09:30:00.000Z" }) }),
          job({ lastRateLimit: detection({ detectedAt: "2026-07-12T14:00:00.000Z" }) }),
          job(),
        ],
        { utcOffsetMinutes: 0 }
      )
    );
    expect(out).toContain("3 detection(s) by hour of day");
    expect(out).toContain("[UTC]");
    expect(out).toContain("of 4 job(s); 1 without a detection");
    expect(out).toContain("busiest at 09:00 (2)");
    expect(out).toContain("◄ peak");
    // Every hour 00..23 gets a row.
    for (const h of ["00:00", "09:00", "14:00", "23:00"]) {
      expect(out).toContain(h);
    }
    // The peak marker sits on the 09:00 row.
    const peakLine = out.split("\n").find((l) => l.includes("◄ peak"));
    expect(peakLine).toContain("09:00");
  });

  it("reflects the offset label for a non-UTC frame", () => {
    const out = renderWhen(
      hourlyRateLimitDistribution([job({ lastRateLimit: detection() })], { utcOffsetMinutes: 9 * 60 })
    );
    expect(out).toContain("[UTC+09:00]");
  });
});

describe("renderWhenJson", () => {
  it("emits a stable envelope with the distribution and optional scope", () => {
    const distribution = hourlyRateLimitDistribution([job({ lastRateLimit: detection() })], {
      utcOffsetMinutes: 0,
    });
    const json = renderWhenJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-12T12:00:00.000Z",
      scope: { statuses: ["waiting_for_reset"] },
      distribution,
    });
    const parsed = JSON.parse(json);
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-12T12:00:00.000Z");
    expect(parsed.scope).toEqual({ statuses: ["waiting_for_reset"] });
    expect(parsed.distribution.withDetection).toBe(1);
    expect(parsed.distribution.buckets).toHaveLength(24);
    expect(parsed.distribution.peakHour).toBe(9);
  });

  it("omits scope when not provided", () => {
    const json = renderWhenJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-12T12:00:00.000Z",
      distribution: hourlyRateLimitDistribution([]),
    });
    expect(JSON.parse(json).scope).toBeUndefined();
  });
});
