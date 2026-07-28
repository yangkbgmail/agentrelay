import { computeResumeSchedule, type RelayJob, type ResumeSchedule } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  NO_SCOPE_MATCH_MESSAGE,
  NO_UPCOMING_MESSAGE,
  NOTHING_WAITING_MESSAGE,
  renderUpcoming,
  renderUpcomingJson,
} from "../src/upcoming.js";

const NOW = Date.parse("2026-07-13T12:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

let seq = 0;
function waiting(offsetMs: number): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "waiting_for_reset",
    resetAt: at(offsetMs),
    createdAt: at(-1000),
    updatedAt: at(-1000),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
  };
}

const EMPTY: ResumeSchedule = computeResumeSchedule([], NOW);

describe("renderUpcoming", () => {
  it("distinguishes an empty store from jobs-but-none-waiting", () => {
    expect(renderUpcoming(EMPTY, { now: NOW, hasAnyJobs: false })).toBe(NO_UPCOMING_MESSAGE);
    expect(renderUpcoming(EMPTY, { now: NOW, hasAnyJobs: true })).toBe(NOTHING_WAITING_MESSAGE);
  });

  it("shows the scope-match message (over the empty guidance) when a filter is active", () => {
    const out = renderUpcoming(EMPTY, { now: NOW, scopeNote: "project=demo", hasAnyJobs: true });
    expect(out).toContain("scope: project=demo");
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
    expect(out).not.toContain(NOTHING_WAITING_MESSAGE);
  });

  it("renders the total, next-reset header and one row per bucket", () => {
    const schedule = computeResumeSchedule([waiting(-60_000), waiting(20 * 60_000), waiting(3 * 86_400_000)], NOW);
    const out = renderUpcoming(schedule, { now: NOW });
    expect(out).toContain("3 jobs waiting to resume");
    expect(out).toContain("next reset due now"); // soonest is overdue
    expect(out).toContain("due now");
    expect(out).toContain("within 1 hour");
    expect(out).toContain("within 24 hours");
    expect(out).toContain("beyond 24 hours");
    // Non-empty non-overdue bucket surfaces its soonest countdown.
    expect(out).toContain("soonest in 20m");
  });

  it("avoids the awkward 'next reset in due now' when the soonest is overdue", () => {
    const out = renderUpcoming(computeResumeSchedule([waiting(-30_000)], NOW), { now: NOW });
    expect(out).toContain("next reset due now");
    expect(out).not.toContain("next reset in due now");
  });

  it("uses 'next reset in <countdown>' when the soonest is still in the future", () => {
    const out = renderUpcoming(computeResumeSchedule([waiting(45 * 60_000)], NOW), { now: NOW });
    expect(out).toContain("next reset in 45m");
  });

  it("uses the singular noun for a single waiting job", () => {
    const out = renderUpcoming(computeResumeSchedule([waiting(30 * 60_000)], NOW), { now: NOW });
    expect(out).toContain("1 job waiting to resume");
  });

  it("does not attach a countdown to the overdue bucket", () => {
    const out = renderUpcoming(computeResumeSchedule([waiting(-5000)], NOW), { now: NOW });
    expect(out).toContain("due now");
    expect(out).not.toContain("soonest in");
  });

  it("emits no ANSI codes when color is off", () => {
    const out = renderUpcoming(computeResumeSchedule([waiting(10 * 60_000)], NOW), { now: NOW, color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe("renderUpcomingJson", () => {
  it("wraps the schedule with storePath, generatedAt and optional scope", () => {
    const schedule = computeResumeSchedule([waiting(15 * 60_000)], NOW);
    const parsed = JSON.parse(
      renderUpcomingJson({
        storePath: "/tmp/store.json",
        generatedAt: "2026-07-13T12:00:00.000Z",
        scope: { projects: ["demo"] },
        schedule,
      })
    );
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-13T12:00:00.000Z");
    expect(parsed.scope.projects).toEqual(["demo"]);
    expect(parsed.schedule.totalWaiting).toBe(1);
    expect(parsed.schedule.buckets).toHaveLength(4);
  });
});
