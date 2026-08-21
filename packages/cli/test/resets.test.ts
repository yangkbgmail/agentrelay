import type { RateLimitDetection, RelayJob } from "@agentrelay/core";
import { computeResetClock } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_RESETS_MESSAGE, renderResets, renderResetsJson } from "../src/resets.js";

let seq = 0;
function detection(overrides: Partial<RateLimitDetection> = {}): RateLimitDetection {
  return {
    pattern: "iso-timestamp",
    rawMatch: "resets at 2026-07-30T15:00:00Z",
    resetAt: "2026-07-30T15:00:00.000Z",
    detectedAt: "2026-07-30T10:00:00.000Z",
    ...overrides,
  };
}

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `abcdef${seq}`,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "waiting_for_reset",
    resetAt: "2026-07-30T15:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    lastRateLimit: detection(),
    ...overrides,
  };
}

describe("renderResets", () => {
  it("shows the empty-clock message when no detections are in scope", () => {
    const clock = computeResetClock([job({ lastRateLimit: null })]);
    const out = renderResets(clock);
    expect(out).toContain(NO_RESETS_MESSAGE);
  });

  it("renders a 24-row histogram with the modal hour marked and footered", () => {
    const clock = computeResetClock([
      job(),
      job(),
      job({ lastRateLimit: detection({ detectedAt: "2026-07-30T14:00:00.000Z" }) }),
    ]);
    const out = renderResets(clock);
    // Header names the basis (hits) and zone.
    expect(out).toContain("rate-limit hits per hour of day");
    expect(out).toContain("UTC");
    // 24 hour rows, 00:00 → 23:00.
    expect(out).toContain("00:00");
    expect(out).toContain("23:00");
    // Busiest hour (10:00, two hits) is marked and footered.
    expect(out).toContain("10:00");
    expect(out).toMatch(/busiest hour 10:00 \(2\)/);
    expect(out).toContain("3 detection(s)");
  });

  it("labels the reset basis when --reset is used", () => {
    const clock = computeResetClock([job()], { basis: "reset" });
    const out = renderResets(clock);
    expect(out).toContain("rate-limit resets per hour of day");
  });

  it("names the local zone label from the offset", () => {
    const clock = computeResetClock([job()], { offsetMinutes: 540 });
    const out = renderResets(clock);
    expect(out).toContain("UTC+09:00");
    // 10:00 UTC + 9h → 19:00 local bucket.
    expect(out).toMatch(/busiest hour 19:00/);
  });

  it("reports unparseable detections in the footer", () => {
    const clock = computeResetClock([job(), job({ lastRateLimit: detection({ detectedAt: "nope" }) })]);
    const out = renderResets(clock);
    expect(out).toContain("1 unparseable skipped");
  });

  it("notes unparseable detections even when the clock is otherwise empty", () => {
    const clock = computeResetClock([job({ lastRateLimit: detection({ detectedAt: "nope" }) })]);
    const out = renderResets(clock);
    expect(out).toContain(NO_RESETS_MESSAGE);
    expect(out).toContain("1 detection(s) had an unparseable timestamp");
  });

  it("prefixes a scope note when given", () => {
    const clock = computeResetClock([job()]);
    const out = renderResets(clock, { scopeNote: "project=demo" });
    expect(out).toContain("[scope: project=demo]");
  });
});

describe("renderResetsJson", () => {
  it("serializes the store path, scope, and full clock", () => {
    const clock = computeResetClock([job()]);
    const json = JSON.parse(
      renderResetsJson({
        storePath: "/tmp/jobs.json",
        generatedAt: "2026-07-30T12:00:00.000Z",
        scope: { projects: ["demo"] },
        clock,
      })
    );
    expect(json.storePath).toBe("/tmp/jobs.json");
    expect(json.generatedAt).toBe("2026-07-30T12:00:00.000Z");
    expect(json.scope).toEqual({ projects: ["demo"] });
    expect(json.clock.basis).toBe("detected");
    expect(json.clock.hours).toHaveLength(24);
    expect(json.clock.busiestHour).toBe(10);
    expect(json.clock.total).toBe(1);
  });
});
