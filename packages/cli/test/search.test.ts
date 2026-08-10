import type { RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  NO_SEARCH_MATCH_MESSAGE,
  renderSearch,
  renderSearchJson,
  type SearchRenderContext,
  searchHeaderLine,
} from "../src/search.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `abcdef${seq}0000`,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue the refactor"],
    cwd: "/tmp/demo",
    status: "waiting_for_reset",
    resetAt: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const now = Date.parse("2026-07-12T12:00:00.000Z");

function ctx(overrides: Partial<SearchRenderContext> = {}): SearchRenderContext {
  return {
    query: "refactor",
    fields: ["command", "project", "id", "error"],
    regex: false,
    caseSensitive: false,
    ...overrides,
  };
}

describe("searchHeaderLine", () => {
  it("describes the query, fields, mode, and match count", () => {
    expect(searchHeaderLine(2, ctx())).toBe(
      'Search "refactor" in command,project,id,error (literal, case-insensitive) — 2 match(es)'
    );
  });

  it("reflects regex and case-sensitive modes and a scope note", () => {
    const line = searchHeaderLine(
      1,
      ctx({ regex: true, caseSensitive: true, fields: ["error"], scopeNote: "status=failed" })
    );
    expect(line).toBe('Search "refactor" in error (regex, case-sensitive) [scope: status=failed] — 1 match(es)');
  });
});

describe("renderSearch", () => {
  it("shows the no-match message when nothing matched", () => {
    const out = renderSearch([], ctx(), { now });
    expect(out).toContain("0 match(es)");
    expect(out).toContain(NO_SEARCH_MATCH_MESSAGE);
  });

  it("prepends the header line before the status table", () => {
    const out = renderSearch([job()], ctx(), { now });
    const lines = out.split("\n");
    expect(lines[0]).toContain('Search "refactor"');
    // The status table header follows.
    expect(out).toContain("PROJECT");
    expect(out).toContain("demo");
  });
});

describe("renderSearchJson", () => {
  it("emits the status snapshot plus a search provenance block", () => {
    const j = job();
    const parsed = JSON.parse(renderSearchJson([j], "/store.json", ctx({ scopeNote: "tool=claude-code" })));
    expect(parsed.storePath).toBe("/store.json");
    expect(parsed.total).toBe(1);
    expect(parsed.jobs[0].id).toBe(j.id);
    expect(parsed.search).toEqual({
      query: "refactor",
      fields: ["command", "project", "id", "error"],
      regex: false,
      caseSensitive: false,
      scope: "tool=claude-code",
    });
  });

  it("respects a limit while keeping the full total", () => {
    const parsed = JSON.parse(renderSearchJson([job(), job(), job()], "/store.json", ctx(), undefined, 2));
    expect(parsed.total).toBe(3);
    expect(parsed.returned).toBe(2);
    expect(parsed.jobs).toHaveLength(2);
  });
});
