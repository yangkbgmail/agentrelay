import { describe, expect, it } from "vitest";
import { compileJobMatcher, isJobSearchField, JOB_SEARCH_FIELDS, jobFieldText, searchJobs } from "../src/search.js";
import type { RelayJob } from "../src/types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
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

describe("isJobSearchField", () => {
  it("accepts every known field and rejects others", () => {
    for (const f of JOB_SEARCH_FIELDS) expect(isJobSearchField(f)).toBe(true);
    expect(isJobSearchField("command")).toBe(true);
    expect(isJobSearchField("cwd")).toBe(false);
    expect(isJobSearchField("")).toBe(false);
  });
});

describe("jobFieldText", () => {
  it("joins the command with spaces", () => {
    expect(jobFieldText(job({ command: ["claude", "-p", "refactor auth"] }), "command")).toBe(
      "claude -p refactor auth"
    );
  });

  it("returns project, id, and error text; null error becomes empty string", () => {
    const j = job({ project: "web-app", id: "abc123", lastError: null });
    expect(jobFieldText(j, "project")).toBe("web-app");
    expect(jobFieldText(j, "id")).toBe("abc123");
    expect(jobFieldText(j, "error")).toBe("");
    expect(jobFieldText(job({ lastError: "ENOSPC: no space left" }), "error")).toBe("ENOSPC: no space left");
  });
});

describe("compileJobMatcher", () => {
  it("rejects an empty query", () => {
    const r = compileJobMatcher({ query: "" });
    expect(r).toEqual({ error: "Search query must not be empty." });
  });

  it("rejects a malformed regex without throwing", () => {
    const r = compileJobMatcher({ query: "(unterminated", regex: true });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/Invalid regular expression/);
  });

  it("matches case-insensitively by default across all fields", () => {
    const r = compileJobMatcher({ query: "REFACTOR" });
    expect("matcher" in r).toBe(true);
    if ("matcher" in r) {
      expect(r.matcher(job({ command: ["claude", "-p", "refactor auth"] }))).toBe(true);
      expect(r.matcher(job({ command: ["claude", "-p", "go"] }))).toBe(false);
    }
  });

  it("honors case-sensitivity when requested", () => {
    const r = compileJobMatcher({ query: "Refactor", caseSensitive: true });
    if ("matcher" in r) {
      expect(r.matcher(job({ command: ["Refactor"] }))).toBe(true);
      expect(r.matcher(job({ command: ["refactor"] }))).toBe(false);
    }
  });

  it("restricts to the named fields only", () => {
    const r = compileJobMatcher({ query: "proj", fields: ["command"] });
    if ("matcher" in r) {
      // "proj" is in the project field, but we only search command here.
      expect(r.matcher(job({ project: "proj", command: ["claude"] }))).toBe(false);
      expect(r.matcher(job({ project: "x", command: ["proj-runner"] }))).toBe(true);
    }
  });
});

describe("searchJobs", () => {
  it("returns matches preserving input order", () => {
    const a = job({ id: "a", command: ["claude", "-p", "migrate db"] });
    const b = job({ id: "b", command: ["claude", "-p", "go"] });
    const c = job({ id: "c", lastError: "migrate failed" });
    const r = searchJobs([a, b, c], { query: "migrate" });
    expect("jobs" in r).toBe(true);
    if ("jobs" in r) {
      expect(r.jobs.map((j) => j.id)).toEqual(["a", "c"]);
    }
  });

  it("supports regex queries", () => {
    const a = job({ id: "a", lastError: "HTTP 429 rate limited" });
    const b = job({ id: "b", lastError: "HTTP 500 server error" });
    const r = searchJobs([a, b], { query: "\\b4\\d\\d\\b", fields: ["error"], regex: true });
    if ("jobs" in r) expect(r.jobs.map((j) => j.id)).toEqual(["a"]);
  });

  it("does not mutate the input array", () => {
    const jobs = [job({ command: ["nope"] })];
    const before = jobs.slice();
    searchJobs(jobs, { query: "zzz" });
    expect(jobs).toEqual(before);
  });

  it("propagates a compile error", () => {
    const r = searchJobs([job()], { query: "", regex: false });
    expect(r).toEqual({ error: "Search query must not be empty." });
  });
});
