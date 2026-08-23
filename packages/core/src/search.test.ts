import { describe, expect, it } from "vitest";
import {
  compileSearch,
  DEFAULT_SEARCH_FIELDS,
  isSearchField,
  jobFieldText,
  matchedFields,
  SEARCH_FIELDS,
  searchJobs,
} from "./search.js";
import type { RelayJob } from "./types.js";

function job(overrides: Partial<RelayJob>): RelayJob {
  return {
    id: "id-0",
    project: "proj",
    tool: "claude-code",
    command: ["claude", "-p", "do the thing"],
    cwd: "/tmp",
    status: "queued",
    resetAt: null,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    attempts: 0,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("isSearchField", () => {
  it("accepts known fields and rejects others", () => {
    for (const field of SEARCH_FIELDS) expect(isSearchField(field)).toBe(true);
    expect(isSearchField("nope")).toBe(false);
    expect(isSearchField("")).toBe(false);
  });
});

describe("jobFieldText", () => {
  it("joins the command with spaces and maps nulls to empty strings", () => {
    const j = job({ command: ["claude", "-p", "refactor auth"], lastError: null });
    expect(jobFieldText(j, "command")).toBe("claude -p refactor auth");
    expect(jobFieldText(j, "error")).toBe("");
    expect(jobFieldText(j, "project")).toBe("proj");
    expect(jobFieldText(j, "tool")).toBe("claude-code");
    expect(jobFieldText(j, "id")).toBe("id-0");
  });
});

describe("compileSearch", () => {
  it("does case-insensitive substring by default", () => {
    const m = compileSearch("Refactor");
    expect(m.test("please refactor the auth module")).toBe(true);
    expect(m.test("nothing here")).toBe(false);
  });

  it("honors caseSensitive", () => {
    const m = compileSearch("Refactor", { caseSensitive: true });
    expect(m.test("Refactor now")).toBe(true);
    expect(m.test("refactor now")).toBe(false);
  });

  it("supports regex mode (case-insensitive by default)", () => {
    const m = compileSearch("auth|billing", { regex: true });
    expect(m.test("the BILLING service")).toBe(true);
    expect(m.test("the auth service")).toBe(true);
    expect(m.test("the payments service")).toBe(false);
  });

  it("throws on an invalid regex", () => {
    expect(() => compileSearch("(", { regex: true })).toThrow();
  });
});

describe("searchJobs", () => {
  const jobs = [
    job({ id: "aaa1", project: "web", command: ["claude", "-p", "refactor auth flow"] }),
    job({ id: "bbb2", project: "api", command: ["codex", "exec", "add billing tests"], tool: "codex-cli" }),
    job({
      id: "ccc3",
      project: "web",
      command: ["claude", "-p", "write docs"],
      status: "failed",
      lastError: "boom: auth token expired",
    }),
  ];

  it("matches across the default fields (command)", () => {
    const hits = searchJobs(jobs, "refactor");
    expect(hits.map((j) => j.id)).toEqual(["aaa1"]);
  });

  it("matches on project", () => {
    const hits = searchJobs(jobs, "api");
    expect(hits.map((j) => j.id)).toEqual(["bbb2"]);
  });

  it("matches on lastError text", () => {
    const hits = searchJobs(jobs, "token expired");
    expect(hits.map((j) => j.id)).toEqual(["ccc3"]);
  });

  it("matches on id", () => {
    expect(searchJobs(jobs, "bbb2").map((j) => j.id)).toEqual(["bbb2"]);
  });

  it("is case-insensitive by default", () => {
    expect(searchJobs(jobs, "AUTH").map((j) => j.id)).toEqual(["aaa1", "ccc3"]);
  });

  it("preserves input order for multiple hits", () => {
    expect(searchJobs(jobs, "auth").map((j) => j.id)).toEqual(["aaa1", "ccc3"]);
  });

  it("returns [] for an empty query (never everything)", () => {
    expect(searchJobs(jobs, "")).toEqual([]);
  });

  it("returns [] when nothing matches", () => {
    expect(searchJobs(jobs, "nonexistent-xyz")).toEqual([]);
  });

  it("does not mutate or alias the input array", () => {
    const before = jobs.slice();
    const result = searchJobs(jobs, "web");
    expect(result).not.toBe(jobs);
    expect(jobs).toEqual(before);
  });

  it("restricts to the requested fields", () => {
    // "web" appears in project but not in any command — restricting to command
    // finds nothing, restricting to project finds both web jobs.
    expect(searchJobs(jobs, "web", { fields: ["command"] })).toEqual([]);
    expect(searchJobs(jobs, "web", { fields: ["project"] }).map((j) => j.id)).toEqual(["aaa1", "ccc3"]);
  });

  it("falls back to the default fields when the field list is empty", () => {
    expect(searchJobs(jobs, "refactor", { fields: [] }).map((j) => j.id)).toEqual(["aaa1"]);
    expect(DEFAULT_SEARCH_FIELDS).toContain("command");
  });

  it("can search the tool field when asked (opt-in)", () => {
    expect(searchJobs(jobs, "codex", { fields: ["tool"] }).map((j) => j.id)).toEqual(["bbb2"]);
    // default fields exclude tool, so a bare "codex-cli" tool query wouldn't hit
    expect(searchJobs(jobs, "codex-cli")).toEqual([]);
  });

  it("supports regex queries", () => {
    expect(searchJobs(jobs, "auth|billing", { regex: true }).map((j) => j.id)).toEqual(["aaa1", "bbb2", "ccc3"]);
  });
});

describe("matchedFields", () => {
  it("reports which searched fields matched", () => {
    const j = job({ id: "auth-1", project: "auth", command: ["claude", "-p", "fix auth"] });
    const m = compileSearch("auth");
    expect(matchedFields(j, m)).toEqual(["command", "project", "id"]);
  });

  it("respects the field restriction", () => {
    const j = job({ id: "auth-1", project: "auth", command: ["claude", "-p", "fix auth"] });
    const m = compileSearch("auth");
    expect(matchedFields(j, m, { fields: ["project"] })).toEqual(["project"]);
  });
});
