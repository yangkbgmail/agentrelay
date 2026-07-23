import type { RateLimitDetection, RelayJob } from "@agentrelay/core";
import { summarizeRateLimitPatterns } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  NO_DETECTIONS_MESSAGE,
  NO_PATTERNS_MESSAGE,
  NO_SCOPE_MATCH_MESSAGE,
  renderPatterns,
  renderPatternsJson,
} from "../src/patterns.js";

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
    detectedAt: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("renderPatterns", () => {
  it("shows the onboarding message for an empty store", () => {
    expect(renderPatterns(summarizeRateLimitPatterns([]))).toBe(NO_PATTERNS_MESSAGE);
  });

  it("shows the no-match message for an empty scoped subset", () => {
    const out = renderPatterns(summarizeRateLimitPatterns([]), { scopeNote: "tool=codex-cli" });
    expect(out).toContain("scope: tool=codex-cli");
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
  });

  it("shows a distinct message when jobs exist but none have a detection", () => {
    const out = renderPatterns(summarizeRateLimitPatterns([job(), job()]));
    expect(out).toContain(NO_DETECTIONS_MESSAGE);
    expect(out).toContain("2 job(s) tracked");
  });

  it("renders a ranked table with counts and an example", () => {
    const out = renderPatterns(
      summarizeRateLimitPatterns([
        job({ lastRateLimit: detection({ pattern: "clock-time" }) }),
        job({ lastRateLimit: detection({ pattern: "clock-time" }) }),
        job({ lastRateLimit: detection({ pattern: "relative-duration", rawMatch: "try again in 4h" }) }),
        job(),
      ])
    );
    expect(out).toContain("3 detection(s) across 2 pattern(s)");
    expect(out).toContain("of 4 job(s); 1 without a detection");
    expect(out).toContain("clock-time");
    expect(out).toContain("relative-duration");
    expect(out).toContain('e.g. "resets at 5:30pm"');
    // clock-time (count 2) is ranked above relative-duration (count 1).
    expect(out.indexOf("clock-time")).toBeLessThan(out.indexOf("relative-duration"));
  });

  it("collapses whitespace in the raw sample", () => {
    const out = renderPatterns(
      summarizeRateLimitPatterns([job({ lastRateLimit: detection({ rawMatch: "resets\n  at   5:30pm" }) })])
    );
    expect(out).toContain('e.g. "resets at 5:30pm"');
  });
});

describe("renderPatternsJson", () => {
  it("emits a stable envelope with the summary and optional scope", () => {
    const summary = summarizeRateLimitPatterns([job({ lastRateLimit: detection() })]);
    const json = renderPatternsJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-12T12:00:00.000Z",
      scope: { statuses: ["waiting_for_reset"] },
      summary,
    });
    const parsed = JSON.parse(json);
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-12T12:00:00.000Z");
    expect(parsed.scope).toEqual({ statuses: ["waiting_for_reset"] });
    expect(parsed.summary.withDetection).toBe(1);
    expect(parsed.summary.patterns[0].pattern).toBe("clock-time");
  });

  it("omits scope when not provided", () => {
    const json = renderPatternsJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-12T12:00:00.000Z",
      summary: summarizeRateLimitPatterns([]),
    });
    expect(JSON.parse(json).scope).toBeUndefined();
  });
});
