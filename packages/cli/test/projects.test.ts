import type { RelayJob } from "@agentrelay/core";
import { summarizeProjects } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  NO_PROJECTS_MESSAGE,
  NO_SCOPE_MATCH_MESSAGE,
  renderProjects,
  renderProjectsJson,
  renderProjectsWatchFrame,
} from "../src/projects.js";

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

describe("renderProjectsWatchFrame", () => {
  it("prepends a live title with the store path, timestamp, and interval", () => {
    const summary = summarizeProjects([job({ project: "web", status: "queued" })]);
    const out = renderProjectsWatchFrame(summary, "/tmp/jobs.json", 5000, NOW);
    const lines = out.split("\n");
    expect(lines[0]).toContain("agentrelay projects");
    expect(lines[0]).toContain("every 5s");
    expect(lines[0]).toContain("Ctrl-C to exit");
    expect(lines[1]).toContain("2026-07-12 12:00:00Z");
    expect(lines[1]).toContain("/tmp/jobs.json");
    expect(lines[2]).toBe("");
    expect(out).toContain("web");
  });

  it("embeds the colored index body with a live countdown", () => {
    const summary = summarizeProjects([
      job({ project: "web", status: "waiting_for_reset", resetAt: "2026-07-12T18:00:00.000Z" }),
    ]);
    const out = renderProjectsWatchFrame(summary, "/tmp/jobs.json", 2000, NOW);
    expect(out).toContain("(in 6h 0m)");
    // Watch frames are always colored (live TTY view).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting escapes are present.
    expect(out).toMatch(/\x1b\[/);
  });

  it("carries the scope note into the frame body", () => {
    const out = renderProjectsWatchFrame(summarizeProjects([]), "/tmp/jobs.json", 2000, NOW, "tool=codex-cli");
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
    expect(out).toContain("scope: tool=codex-cli");
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
