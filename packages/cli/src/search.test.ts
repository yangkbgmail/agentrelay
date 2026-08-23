import type { RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_SEARCH_MATCH_MESSAGE, renderSearch, renderSearchJson, searchHeadline } from "./search.js";

function job(overrides: Partial<RelayJob>): RelayJob {
  return {
    id: "aaaaaaaa-1111",
    project: "web",
    tool: "claude-code",
    command: ["claude", "-p", "refactor auth"],
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

const NOW = Date.parse("2026-08-23T00:00:00.000Z");

describe("searchHeadline", () => {
  it("quotes a substring query and lists the fields", () => {
    expect(searchHeadline({ query: "auth", matched: 2, total: 40, fields: ["command", "project"] })).toBe(
      '2 of 40 job(s) match "auth" (in command, project)'
    );
  });

  it("slashes a regex query", () => {
    expect(searchHeadline({ query: "auth|billing", matched: 1, total: 3, fields: ["command"], regex: true })).toBe(
      "1 of 3 job(s) match /auth|billing/ (in command)"
    );
  });
});

describe("renderSearch", () => {
  it("shows the headline plus a table when there are matches", () => {
    const out = renderSearch([job({})], "auth", { now: NOW, fields: ["command", "project"], total: 5 });
    expect(out).toContain('1 of 5 job(s) match "auth"');
    expect(out).toContain("PROJECT");
    expect(out).toContain("web");
  });

  it("shows the no-match message when nothing matched", () => {
    const out = renderSearch([], "zzz", { now: NOW, fields: ["command"], total: 5 });
    expect(out).toContain("0 of 5 job(s) match");
    expect(out).toContain(NO_SEARCH_MATCH_MESSAGE);
  });
});

describe("renderSearchJson", () => {
  it("emits query, fields, counts, and the matched jobs", () => {
    const parsed = JSON.parse(
      renderSearchJson([job({ id: "x1" })], "auth", { total: 5, fields: ["command"], storePath: "/store.json" })
    );
    expect(parsed.query).toBe("auth");
    expect(parsed.regex).toBe(false);
    expect(parsed.fields).toEqual(["command"]);
    expect(parsed.total).toBe(5);
    expect(parsed.matched).toBe(1);
    expect(parsed.returned).toBe(1);
    expect(parsed.jobs[0].id).toBe("x1");
    expect(parsed.storePath).toBe("/store.json");
  });

  it("caps the emitted jobs at --limit but keeps the true match count", () => {
    const many = [job({ id: "a" }), job({ id: "b" }), job({ id: "c" })];
    const parsed = JSON.parse(renderSearchJson(many, "refactor", { total: 3, fields: ["command"], limit: 2 }));
    expect(parsed.matched).toBe(3);
    expect(parsed.returned).toBe(2);
    expect(parsed.jobs).toHaveLength(2);
  });
});
