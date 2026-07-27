import type { RateLimitDetection, RelayJob, WaitTimeStats } from "@agentrelay/core";
import { computeWaitTime } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  NO_JOBS_MESSAGE,
  NO_SCOPE_MATCH_MESSAGE,
  NO_WAITS_MESSAGE,
  renderWaitTime,
  renderWaitTimeJson,
} from "../src/waittime.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `aaaaaaaa${seq}`,
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

function detection(overrides: Partial<RateLimitDetection> = {}): RateLimitDetection {
  return {
    pattern: "clock-time",
    rawMatch: "resets at 5pm",
    detectedAt: "2026-07-13T00:00:00.000Z",
    resetAt: "2026-07-13T01:00:00.000Z", // 1h
    ...overrides,
  };
}

function statsOf(jobs: RelayJob[]): WaitTimeStats {
  return computeWaitTime(jobs);
}

describe("renderWaitTime", () => {
  it("shows the no-jobs message on an empty store", () => {
    expect(renderWaitTime(statsOf([]))).toContain(NO_JOBS_MESSAGE);
  });

  it("switches to the no-match message when a scope is active", () => {
    const out = renderWaitTime(statsOf([]), { scopeNote: "tool=claude-code" });
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
    expect(out).toContain("scope: tool=claude-code");
  });

  it("shows the no-waits message when jobs exist but none were rate-limited", () => {
    const out = renderWaitTime(statsOf([job({ lastRateLimit: null }), job({ lastRateLimit: null })]));
    expect(out).toContain(NO_WAITS_MESSAGE);
    expect(out).toContain("2 job(s) tracked, 0 with a recorded rate-limit wait");
  });

  it("renders the headline total, average/shortest/longest and a drill-down id", () => {
    const out = renderWaitTime(
      statsOf([
        job({ id: "shortjob0", lastRateLimit: detection({ resetAt: "2026-07-13T01:00:00.000Z" }) }), // 1h
        job({ id: "longjob00", lastRateLimit: detection({ resetAt: "2026-07-13T04:00:00.000Z" }) }), // 3h -> wait, 4h
      ])
    );
    expect(out).toContain("of rate-limit wait absorbed");
    expect(out).toContain("across 2 job(s)");
    expect(out).toContain("average:");
    expect(out).toContain("shortest:");
    expect(out).toContain("longest:");
    // longest is the 4h job -> its id prefix appears
    expect(out).toContain("longjob0");
  });
});

describe("renderWaitTimeJson", () => {
  it("emits store, generatedAt, scope, and stats", () => {
    const stats = statsOf([job({ lastRateLimit: detection() })]);
    const parsed = JSON.parse(
      renderWaitTimeJson({
        storePath: "/tmp/jobs.json",
        generatedAt: "2026-07-13T02:00:00.000Z",
        scope: { tools: ["claude-code"] },
        stats,
      })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-13T02:00:00.000Z");
    expect(parsed.scope).toEqual({ tools: ["claude-code"] });
    expect(parsed.stats.withWait).toBe(1);
    expect(parsed.stats.totalWaitMs).toBe(60 * 60 * 1000);
  });

  it("omits scope when none is active", () => {
    const parsed = JSON.parse(
      renderWaitTimeJson({ storePath: "/tmp/jobs.json", generatedAt: "2026-07-13T02:00:00.000Z", stats: statsOf([]) })
    );
    expect(parsed.scope).toBeUndefined();
    expect(parsed.stats.total).toBe(0);
  });
});
