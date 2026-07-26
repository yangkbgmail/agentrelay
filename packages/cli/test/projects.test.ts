import type { RelayJob } from "@agentrelay/core";
import { summarizeProjects } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_PROJECTS_MESSAGE, NO_SCOPE_MATCH_MESSAGE, renderProjects, renderProjectsJson } from "../src/projects.js";

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

// A fixed "now" comfortably before the reset times below, for a stable countdown.
const NOW = Date.parse("2026-07-12T12:00:00.000Z");

describe("renderProjects", () => {
  it("shows the onboarding message for an empty store", () => {
    expect(renderProjects(summarizeProjects([]))).toBe(NO_PROJECTS_MESSAGE);
  });

  it("shows the no-match message for an empty scoped subset", () => {
    const out = renderProjects(summarizeProjects([]), { scopeNote: "tool=codex-cli" });
    expect(out).toContain("scope: tool=codex-cli");
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
  });

  it("renders a header and one row per project", () => {
    const out = renderProjects(
      summarizeProjects([
        job({ project: "web", status: "completed" }),
        job({ project: "web", status: "queued" }),
        job({ project: "api", status: "failed" }),
      ]),
      { now: NOW }
    );
    expect(out).toContain("2 project(s)");
    expect(out).toContain("across 3 job(s)");
    expect(out).toContain("web");
    expect(out).toContain("api");
  });

  it("shows the soonest reset with a countdown for a waiting project", () => {
    const out = renderProjects(
      summarizeProjects([job({ project: "web", status: "waiting_for_reset", resetAt: "2026-07-12T18:00:00.000Z" })]),
      { now: NOW }
    );
    expect(out).toContain("2026-07-12T18:00:00.000Z");
    expect(out).toContain("(in 6h 0m)");
  });

  it("shows (idle) for a project with only terminal jobs and no reset", () => {
    const out = renderProjects(summarizeProjects([job({ project: "web", status: "completed" })]), { now: NOW });
    expect(out).toContain("(idle)");
  });

  it("echoes an active scope note once at the top", () => {
    const out = renderProjects(summarizeProjects([job({ project: "web" })]), {
      scopeNote: "status=completed",
      now: NOW,
    });
    expect(out).toContain("scope: status=completed");
  });
});

describe("renderProjectsJson", () => {
  it("wraps the summary in a stable envelope", () => {
    const summary = summarizeProjects([job({ project: "web", status: "queued" })]);
    const json = renderProjectsJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-12T12:00:00.000Z",
      summary,
    });
    const parsed = JSON.parse(json);
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-12T12:00:00.000Z");
    expect(parsed.scope).toBeUndefined();
    expect(parsed.summary.projectCount).toBe(1);
    expect(parsed.summary.projects[0].project).toBe("web");
    expect(parsed.summary.projects[0].active).toBe(1);
  });

  it("includes the scope when one is active", () => {
    const json = renderProjectsJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-12T12:00:00.000Z",
      scope: { statuses: ["queued"] },
      summary: summarizeProjects([]),
    });
    expect(JSON.parse(json).scope).toEqual({ statuses: ["queued"] });
  });
});
