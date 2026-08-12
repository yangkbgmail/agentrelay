import { planTick, type RelayJob, type TickPlan } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_DUE_MESSAGE, renderTickPlan, renderTickPlanJson } from "../src/tick.js";

const NOW = Date.parse("2026-07-30T10:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "abcdef1234567890",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "waiting_for_reset",
    resetAt: at(-90 * 60_000),
    createdAt: at(-3 * 3_600_000),
    updatedAt: at(-3 * 3_600_000),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function plan(jobs: RelayJob[]): TickPlan {
  return planTick(jobs, NOW);
}

describe("renderTickPlan", () => {
  it("shows the no-due message when nothing would resume", () => {
    expect(renderTickPlan(plan([]))).toBe(NO_DUE_MESSAGE);
  });

  it("renders one row per due job, most-overdue first, with a header", () => {
    const out = renderTickPlan(
      plan([
        job({ id: "recent00", project: "recent-app", resetAt: at(-30 * 60_000) }),
        job({ id: "ancient0", project: "ancient-app", resetAt: at(-4 * 3_600_000) }),
      ])
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("PROJECT");
    expect(lines[0]).toContain("TOOL");
    expect(lines[0]).toContain("DUE FOR");
    expect(out.indexOf("ancient-app")).toBeLessThan(out.indexOf("recent-app"));
  });

  it("reuses the shared duration format for the due span", () => {
    const out = renderTickPlan(plan([job({ resetAt: at(-2 * 3_600_000 - 5 * 60_000) })]));
    expect(out).toContain("2h 5m");
  });

  it("shows 'now' for a job whose reset is exactly at the reference time", () => {
    const out = renderTickPlan(plan([job({ resetAt: at(0) })]));
    expect(out).toContain("now");
  });

  it("footer reports the total and how to actually run it", () => {
    const out = renderTickPlan(plan([job({ id: "j1" }), job({ id: "j2" })]));
    expect(out).toContain("2 jobs would resume this tick.");
    expect(out).toContain("agentrelay tick");
  });

  it("footer uses the singular for a single job", () => {
    const out = renderTickPlan(plan([job()]));
    expect(out).toContain("1 job would resume this tick.");
  });
});

describe("renderTickPlanJson", () => {
  it("carries the store path, dryRun flag, and full plan", () => {
    const p = plan([job({ id: "j1" })]);
    const parsed = JSON.parse(
      renderTickPlanJson({ storePath: "/tmp/jobs.json", generatedAt: "2026-07-30T10:00:00.000Z", plan: p })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.plan.total).toBe(1);
    expect(parsed.plan.resumes[0].job.id).toBe("j1");
  });
});
