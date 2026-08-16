import type { RelayValue } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_SAVINGS_MATCH_MESSAGE, NO_SAVINGS_MESSAGE, renderSavings, renderSavingsJson } from "./savings.js";

/** A RelayValue with the given overrides — mirrors computeRelayValue's shape. */
function value(overrides: Partial<RelayValue> = {}): RelayValue {
  return {
    totalJobs: 0,
    autoResumes: 0,
    resumedJobs: 0,
    manualInterventionsSaved: 0,
    unattendedMs: 0,
    longestUnattendedMs: 0,
    unattendedJobs: 0,
    ...overrides,
  };
}

describe("renderSavings", () => {
  it("shows the never-stepped-in message when nothing was resumed", () => {
    const out = renderSavings(value());
    expect(out).toContain(NO_SAVINGS_MESSAGE);
    expect(out).not.toContain("Auto-resumes");
  });

  it("switches to the match variant when a scope filters everything out", () => {
    const out = renderSavings(value(), { scopeNote: "project=x" });
    expect(out).toContain(NO_SAVINGS_MATCH_MESSAGE);
    expect(out).toContain("scope: project=x");
  });

  it("renders resume counts and unattended time", () => {
    const out = renderSavings(
      value({
        totalJobs: 3,
        autoResumes: 5,
        resumedJobs: 2,
        manualInterventionsSaved: 5,
        unattendedMs: 2 * 3600_000 + 30 * 60_000,
        longestUnattendedMs: 2 * 3600_000,
        unattendedJobs: 2,
      })
    );
    expect(out).toContain("Auto-resumes");
    expect(out).toContain("5");
    expect(out).toContain("across 2 jobs");
    expect(out).toContain("Manual restarts saved");
    expect(out).toContain("2h 30m");
    expect(out).toContain("over 2 resolved jobs");
    expect(out).toContain("Longest single save");
    expect(out).toContain("2h 0m");
  });

  it("uses singular wording for a single job/restart", () => {
    const out = renderSavings(
      value({
        autoResumes: 1,
        resumedJobs: 1,
        manualInterventionsSaved: 1,
        unattendedJobs: 1,
        unattendedMs: 5000,
        longestUnattendedMs: 5000,
      })
    );
    expect(out).toContain("across 1 job");
    expect(out).toContain("Manual restart saved");
    expect(out).toContain("over 1 resolved job");
  });

  it("notes when resumed jobs haven't resolved yet", () => {
    const out = renderSavings(
      value({ autoResumes: 2, resumedJobs: 1, manualInterventionsSaved: 2, unattendedJobs: 0 })
    );
    expect(out).toContain("Auto-resumes");
    expect(out).toContain("no resumed job has resolved yet");
    expect(out).not.toContain("Longest single save");
  });

  it("emits no ANSI codes when color is off", () => {
    const out = renderSavings(value({ autoResumes: 3, resumedJobs: 1, manualInterventionsSaved: 3 }), { color: false });
    expect(out).not.toContain("\x1b[");
  });
});

describe("renderSavingsJson", () => {
  it("wraps the value with store path and scope", () => {
    const v = value({ autoResumes: 4, resumedJobs: 2, manualInterventionsSaved: 4 });
    const json = JSON.parse(
      renderSavingsJson(v, "/tmp/jobs.json", { scopeNote: "since=7d", generatedAt: "2026-08-16T00:00:00.000Z" })
    );
    expect(json.storePath).toBe("/tmp/jobs.json");
    expect(json.scope).toBe("since=7d");
    expect(json.generatedAt).toBe("2026-08-16T00:00:00.000Z");
    expect(json.value).toEqual(v);
  });

  it("uses null scope when none is given", () => {
    const json = JSON.parse(renderSavingsJson(value(), "/tmp/jobs.json", { generatedAt: "2026-08-16T00:00:00.000Z" }));
    expect(json.scope).toBeNull();
  });
});
