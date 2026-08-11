import { describe, expect, it } from "vitest";
import { computeRelaySavings } from "./savings.js";
import type { AgentTool, JobStatus, RateLimitDetection, RelayJob } from "./types.js";

/** Minimal job factory — only the fields `computeRelaySavings` reads matter. */
function job(
  overrides: Partial<RelayJob> & { id: string } & {
    tool?: AgentTool;
    lastRateLimit?: RateLimitDetection | null;
  }
): RelayJob {
  return {
    id: overrides.id,
    project: overrides.project ?? "demo",
    tool: overrides.tool ?? "claude-code",
    command: overrides.command ?? ["claude", "-p", "continue"],
    cwd: overrides.cwd ?? "/tmp",
    status: (overrides.status ?? "completed") as JobStatus,
    resetAt: overrides.resetAt ?? null,
    createdAt: overrides.createdAt ?? "2026-08-11T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-08-11T00:00:00.000Z",
    attempts: overrides.attempts ?? 1,
    lastError: overrides.lastError ?? null,
    lastOutputTail: overrides.lastOutputTail ?? null,
    lastRateLimit: overrides.lastRateLimit,
  };
}

/** A detection whose window is `hours` long, detected at a fixed base. */
function detection(hours: number, detectedAt = "2026-08-11T00:00:00.000Z"): RateLimitDetection {
  const resetAt = new Date(Date.parse(detectedAt) + hours * 3_600_000).toISOString();
  return { pattern: "claude-resets-at", rawMatch: "resets at ...", resetAt, detectedAt };
}

describe("computeRelaySavings", () => {
  it("returns an all-zero report for an empty queue", () => {
    const s = computeRelaySavings([]);
    expect(s.total).toBe(0);
    expect(s.bridged).toBe(0);
    expect(s.totalBridgedMs).toBe(0);
    expect(s.averageBridgeMs).toBe(0);
    expect(s.longestBridgeMs).toBe(0);
    expect(s.longestBridgeJobId).toBeNull();
    expect(s.byTool).toEqual([]);
  });

  it("counts jobs without a detection as total-but-not-bridged", () => {
    const s = computeRelaySavings([job({ id: "a", lastRateLimit: null }), job({ id: "b" })]);
    expect(s.total).toBe(2);
    expect(s.bridged).toBe(0);
    expect(s.totalBridgedMs).toBe(0);
  });

  it("sums bridged windows and tracks the longest with its job id", () => {
    const s = computeRelaySavings([
      job({ id: "short", lastRateLimit: detection(1) }),
      job({ id: "long", lastRateLimit: detection(5) }),
      job({ id: "mid", lastRateLimit: detection(2) }),
    ]);
    expect(s.total).toBe(3);
    expect(s.bridged).toBe(3);
    expect(s.totalBridgedMs).toBe(8 * 3_600_000);
    expect(s.averageBridgeMs).toBeCloseTo((8 / 3) * 3_600_000);
    expect(s.longestBridgeMs).toBe(5 * 3_600_000);
    expect(s.longestBridgeJobId).toBe("long");
  });

  it("skips malformed detections: unparseable timestamps or reset-before-detection", () => {
    const s = computeRelaySavings([
      job({ id: "ok", lastRateLimit: detection(3) }),
      job({
        id: "bad-iso",
        lastRateLimit: { pattern: "p", rawMatch: "r", resetAt: "not-a-date", detectedAt: "also-bad" },
      }),
      job({
        id: "reversed",
        lastRateLimit: {
          pattern: "p",
          rawMatch: "r",
          detectedAt: "2026-08-11T05:00:00.000Z",
          resetAt: "2026-08-11T01:00:00.000Z",
        },
      }),
    ]);
    expect(s.total).toBe(3);
    expect(s.bridged).toBe(1);
    expect(s.totalBridgedMs).toBe(3 * 3_600_000);
    expect(s.longestBridgeJobId).toBe("ok");
  });

  it("counts a zero-length window as bridged but adds nothing", () => {
    const s = computeRelaySavings([job({ id: "instant", lastRateLimit: detection(0) })]);
    expect(s.bridged).toBe(1);
    expect(s.totalBridgedMs).toBe(0);
    expect(s.longestBridgeMs).toBe(0);
    // Even a zero window records the job as the current longest holder.
    expect(s.longestBridgeJobId).toBe("instant");
  });

  it("breaks down by tool, ranked by bridged time then tool name", () => {
    const s = computeRelaySavings([
      job({ id: "c1", tool: "claude-code", lastRateLimit: detection(1) }),
      job({ id: "c2", tool: "claude-code", lastRateLimit: detection(1) }),
      job({ id: "x1", tool: "codex-cli", lastRateLimit: detection(4) }),
      job({ id: "g1", tool: "generic", lastRateLimit: null }),
    ]);
    expect(s.byTool).toEqual([
      { tool: "codex-cli", jobs: 1, bridgedMs: 4 * 3_600_000 },
      { tool: "claude-code", jobs: 2, bridgedMs: 2 * 3_600_000 },
    ]);
    // generic contributed no usable window, so it gets no bucket.
    expect(s.byTool.some((t) => t.tool === "generic")).toBe(false);
  });

  it("breaks ties on equal bridged time by tool name ascending", () => {
    const s = computeRelaySavings([
      job({ id: "x", tool: "codex-cli", lastRateLimit: detection(2) }),
      job({ id: "c", tool: "claude-code", lastRateLimit: detection(2) }),
    ]);
    expect(s.byTool.map((t) => t.tool)).toEqual(["claude-code", "codex-cli"]);
  });
});
