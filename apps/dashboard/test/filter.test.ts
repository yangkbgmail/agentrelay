import type { RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { type DashboardFilter, distinctProjects, distinctTools, filterJobs, isFilterActive } from "../lib/filter";

function job(overrides: Partial<RelayJob>): RelayJob {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    project: "proj",
    tool: "claude-code",
    command: ["claude", "-p", "hi"],
    cwd: "/tmp",
    status: "queued",
    attempts: 0,
    resetAt: null,
    lastError: null,
    lastOutputTail: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  } as RelayJob;
}

const jobs: RelayJob[] = [
  job({ id: "aaaaaaaa-0001", project: "web", tool: "claude-code", status: "completed", command: ["claude", "build"] }),
  job({ id: "bbbbbbbb-0002", project: "api", tool: "codex-cli", status: "failed", command: ["codex", "refactor"] }),
  job({
    id: "cccccccc-0003",
    project: "web",
    tool: "generic",
    status: "waiting_for_reset",
    command: ["echo", "deploy"],
  }),
];

describe("isFilterActive", () => {
  it("is false for an empty filter", () => {
    expect(isFilterActive({})).toBe(false);
    expect(isFilterActive({ statuses: [], tools: [], projects: [], search: "  " })).toBe(false);
  });

  it("is true when any dimension is set", () => {
    expect(isFilterActive({ statuses: ["failed"] })).toBe(true);
    expect(isFilterActive({ tools: ["codex-cli"] })).toBe(true);
    expect(isFilterActive({ projects: ["web"] })).toBe(true);
    expect(isFilterActive({ search: "deploy" })).toBe(true);
  });
});

describe("filterJobs", () => {
  it("returns a fresh copy of everything for an empty filter", () => {
    const result = filterJobs(jobs, {});
    expect(result).toHaveLength(3);
    expect(result).not.toBe(jobs);
  });

  it("filters by status (OR within the dimension)", () => {
    const result = filterJobs(jobs, { statuses: ["failed", "completed"] });
    expect(result.map((j) => j.project)).toEqual(["web", "api"]);
  });

  it("filters by tool as raw string", () => {
    expect(filterJobs(jobs, { tools: ["codex-cli"] }).map((j) => j.project)).toEqual(["api"]);
  });

  it("filters by project (exact match)", () => {
    expect(filterJobs(jobs, { projects: ["web"] })).toHaveLength(2);
  });

  it("combines dimensions with AND", () => {
    const result = filterJobs(jobs, { projects: ["web"], statuses: ["completed"] });
    expect(result.map((j) => j.id)).toEqual(["aaaaaaaa-0001"]);
  });

  it("searches case-insensitively over project, id, and command", () => {
    expect(filterJobs(jobs, { search: "REFACTOR" }).map((j) => j.project)).toEqual(["api"]);
    expect(filterJobs(jobs, { search: "0003" }).map((j) => j.project)).toEqual(["web"]);
    expect(filterJobs(jobs, { search: "api" }).map((j) => j.project)).toEqual(["api"]);
  });

  it("treats whitespace-only search as no search", () => {
    expect(filterJobs(jobs, { search: "   " })).toHaveLength(3);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterJobs(jobs, { statuses: ["cancelled"] as DashboardFilter["statuses"] })).toEqual([]);
  });

  it("does not mutate the input list", () => {
    const snapshot = jobs.map((j) => j.id);
    filterJobs(jobs, { statuses: ["failed"], search: "x" });
    expect(jobs.map((j) => j.id)).toEqual(snapshot);
  });
});

describe("distinct option helpers", () => {
  it("lists distinct projects sorted alphabetically", () => {
    expect(distinctProjects(jobs)).toEqual(["api", "web"]);
  });

  it("lists distinct tools sorted alphabetically", () => {
    expect(distinctTools(jobs)).toEqual(["claude-code", "codex-cli", "generic"]);
  });

  it("returns an empty list for no jobs", () => {
    expect(distinctProjects([])).toEqual([]);
    expect(distinctTools([])).toEqual([]);
  });
});
