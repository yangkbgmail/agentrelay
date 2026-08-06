import type { RelayJob } from "@agentrelay/core";
import { computeAttemptDistribution } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_ATTEMPTS_MESSAGE, NO_SCOPE_MATCH_MESSAGE, renderAttempts, renderAttemptsJson } from "../src/attempts.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `abcdef${seq}`,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("renderAttempts", () => {
  it("shows the onboarding message for an empty store", () => {
    const out = renderAttempts(computeAttemptDistribution([]), { color: false });
    expect(out).toBe(NO_ATTEMPTS_MESSAGE);
  });

  it("shows the scope-match message when a filter matches nothing", () => {
    const out = renderAttempts(computeAttemptDistribution([]), { color: false, scopeNote: "tool=codex-cli" });
    expect(out).toContain("scope: tool=codex-cli");
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
  });

  it("renders one bar row per attempts bucket, ascending, with counts", () => {
    const out = renderAttempts(
      computeAttemptDistribution([
        job({ attempts: 1 }),
        job({ attempts: 1 }),
        job({ attempts: 1 }),
        job({ attempts: 3 }),
      ]),
      { color: false }
    );
    expect(out).toContain("2 attempt level(s)");
    expect(out).toContain("across 4 job(s)");
    // Busiest bucket (attempts=1, count 3) draws the widest bar.
    expect(out).toMatch(/1×\s+█+ 3/);
    expect(out).toMatch(/3×\s+█+ 1/);
    // Footer aggregates.
    expect(out).toContain("total attempts 6");
    expect(out).toContain("mean 1.5");
    expect(out).toContain("max 3×");
  });

  it("annotates a bucket that mixes active and terminal jobs", () => {
    const out = renderAttempts(
      computeAttemptDistribution([
        job({ attempts: 2, status: "waiting_for_reset" }),
        job({ attempts: 2, status: "completed" }),
      ]),
      { color: false }
    );
    expect(out).toContain("(1 active, 1 done)");
  });

  it("gives every non-empty bucket at least one bar block", () => {
    // A rare bucket (count 1) next to a busy one (count 20) must not render an
    // empty bar — rounding down to 0 blocks would make it invisible.
    const jobs = [job({ attempts: 5 })];
    for (let i = 0; i < 20; i++) jobs.push(job({ attempts: 1 }));
    const out = renderAttempts(computeAttemptDistribution(jobs), { color: false });
    expect(out).toMatch(/5×\s+█ 1/);
  });
});

describe("renderAttemptsJson", () => {
  it("echoes the store path, scope, and full distribution", () => {
    const distribution = computeAttemptDistribution([job({ attempts: 1 }), job({ attempts: 2 })]);
    const json = renderAttemptsJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-08-06T00:00:00.000Z",
      scope: { tools: ["claude-code"] },
      distribution,
    });
    const parsed = JSON.parse(json);
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-08-06T00:00:00.000Z");
    expect(parsed.scope).toEqual({ tools: ["claude-code"] });
    expect(parsed.distribution.total).toBe(2);
    expect(parsed.distribution.buckets).toHaveLength(2);
  });
});
