import type { RateLimitDetection, RelayJob } from "@agentrelay/core";
import { computeRateLimitWindows } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  NO_SCOPE_MATCH_MESSAGE,
  NO_WINDOWS_DETECTED_MESSAGE,
  NO_WINDOWS_MESSAGE,
  renderWindows,
  renderWindowsJson,
} from "../src/windows.js";

const HOUR = 60 * 60 * 1000;

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

/** A detection whose window is `hours` long. */
function detection(hours: number): RateLimitDetection {
  const detectedAt = "2026-07-12T00:00:00.000Z";
  return {
    pattern: "clock-time",
    rawMatch: "resets at ...",
    detectedAt,
    resetAt: new Date(Date.parse(detectedAt) + hours * HOUR).toISOString(),
  };
}

describe("renderWindows", () => {
  it("shows the onboarding message for an empty store", () => {
    expect(renderWindows(computeRateLimitWindows([]))).toBe(NO_WINDOWS_MESSAGE);
  });

  it("shows the no-match message for an empty scoped subset", () => {
    const out = renderWindows(computeRateLimitWindows([]), { scopeNote: "tool=codex-cli" });
    expect(out).toContain("scope: tool=codex-cli");
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
  });

  it("shows a distinct message when jobs exist but none have a window", () => {
    const out = renderWindows(computeRateLimitWindows([job(), job()]));
    expect(out).toContain(NO_WINDOWS_DETECTED_MESSAGE);
    expect(out).toContain("2 job(s) tracked");
  });

  it("renders the duration distribution with counts", () => {
    const out = renderWindows(
      computeRateLimitWindows([
        job({ lastRateLimit: detection(1) }),
        job({ lastRateLimit: detection(5) }),
        job({ lastRateLimit: detection(9) }),
        job(), // no detection
      ])
    );
    expect(out).toContain("rate-limit window");
    expect(out).toContain("over 3 detection(s); 1 without");
    expect(out).toContain("min 1h 0m");
    expect(out).toContain("max 9h 0m");
    expect(out).toContain("median 5h 0m");
    expect(out).toContain("avg 5h 0m");
  });
});

describe("renderWindowsJson", () => {
  it("emits a stable envelope with the distribution and optional scope", () => {
    const windows = computeRateLimitWindows([job({ lastRateLimit: detection(5) })]);
    const json = renderWindowsJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-12T12:00:00.000Z",
      scope: { statuses: ["waiting_for_reset"] },
      windows,
    });
    const parsed = JSON.parse(json);
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-12T12:00:00.000Z");
    expect(parsed.scope).toEqual({ statuses: ["waiting_for_reset"] });
    expect(parsed.windows.withWindow).toBe(1);
    expect(parsed.windows.medianMs).toBe(5 * HOUR);
  });

  it("omits scope when not provided", () => {
    const json = renderWindowsJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-12T12:00:00.000Z",
      windows: computeRateLimitWindows([]),
    });
    expect(JSON.parse(json).scope).toBeUndefined();
  });
});
