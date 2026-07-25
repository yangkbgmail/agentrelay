import type { ErrorBreakdown, RelayJob } from "@agentrelay/core";
import { computeErrorBreakdown, groupErrorBreakdown } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  NO_ERROR_MATCH_MESSAGE,
  NO_ERRORS_MESSAGE,
  NO_GROUPED_ERROR_MATCH_MESSAGE,
  NO_GROUPED_ERRORS_MESSAGE,
  renderErrorBreakdown,
  renderErrorBreakdownJson,
  renderGroupedErrorBreakdown,
  renderGroupedErrorBreakdownJson,
} from "../src/errors.js";

function job(overrides: Partial<RelayJob>): RelayJob {
  return {
    id: "aaaaaaaa1111",
    project: "proj",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "failed",
    resetAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:05:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function breakdownOf(jobs: RelayJob[]): ErrorBreakdown {
  return computeErrorBreakdown(jobs);
}

describe("renderErrorBreakdown", () => {
  it("shows the no-errors message on an empty breakdown", () => {
    const out = renderErrorBreakdown(breakdownOf([]));
    expect(out).toContain(NO_ERRORS_MESSAGE);
  });

  it("switches to the no-match message when a scope is active", () => {
    const out = renderErrorBreakdown(breakdownOf([]), { scopeNote: "status=failed" });
    expect(out).toContain(NO_ERROR_MATCH_MESSAGE);
    expect(out).toContain("scope: status=failed");
  });

  it("renders ranked groups with counts and signatures", () => {
    const out = renderErrorBreakdown(
      breakdownOf([
        job({ id: "id-a", lastError: "spawn ENOENT" }),
        job({ id: "id-b", lastError: "spawn ENOENT" }),
        job({ id: "id-c", lastError: "rate limited" }),
      ])
    );
    expect(out).toContain("2 jobs");
    expect(out).toContain("spawn ENOENT");
    expect(out).toContain("1 job");
    expect(out).toContain("rate limited");
    expect(out).toContain("3 job(s) with errors across 2 distinct reason(s)");
  });

  it("respects --limit and shows a hidden-count footer", () => {
    const out = renderErrorBreakdown(
      breakdownOf([
        job({ id: "a", lastError: "err one" }),
        job({ id: "b", lastError: "err two" }),
        job({ id: "c", lastError: "err three" }),
      ]),
      { limit: 1 }
    );
    expect(out).toContain("err one");
    expect(out).not.toContain("err two");
    expect(out).toContain("2 more reason(s) not shown");
  });

  it("elides extra job ids beyond the first few", () => {
    const jobs = Array.from({ length: 5 }, (_, i) => job({ id: `job${i}00000`, lastError: "same boom" }));
    const out = renderErrorBreakdown(breakdownOf(jobs));
    expect(out).toContain("+2 more");
  });
});

describe("renderErrorBreakdownJson", () => {
  it("emits store, scope, totals, and groups", () => {
    const breakdown = breakdownOf([job({ id: "id-a", lastError: "boom" }), job({ id: "id-b", lastError: "boom" })]);
    const parsed = JSON.parse(renderErrorBreakdownJson(breakdown, "/tmp/jobs.json", { scopeNote: "tool=claude-code" }));
    expect(parsed.store).toBe("/tmp/jobs.json");
    expect(parsed.scope).toBe("tool=claude-code");
    expect(parsed.totalWithErrors).toBe(2);
    expect(parsed.distinctSignatures).toBe(1);
    expect(parsed.groups[0].count).toBe(2);
    expect(parsed.groups[0].signature).toBe("boom");
  });

  it("emits a null scope when none is active", () => {
    const parsed = JSON.parse(renderErrorBreakdownJson(breakdownOf([]), "/tmp/jobs.json"));
    expect(parsed.scope).toBeNull();
    expect(parsed.groups).toEqual([]);
  });
});

describe("renderGroupedErrorBreakdown", () => {
  it("shows the no-errors message when no group has errors", () => {
    const out = renderGroupedErrorBreakdown(groupErrorBreakdown([], "project"), "project");
    expect(out).toContain("Error breakdown by project");
    expect(out).toContain(NO_GROUPED_ERRORS_MESSAGE);
  });

  it("switches to the no-match message when a scope is active", () => {
    const out = renderGroupedErrorBreakdown(groupErrorBreakdown([], "project"), "project", {
      scopeNote: "tool=codex-cli",
    });
    expect(out).toContain(NO_GROUPED_ERROR_MATCH_MESSAGE);
    expect(out).toContain("scope: tool=codex-cli");
  });

  it("renders one block per group with its key, count and nested reasons", () => {
    const groups = groupErrorBreakdown(
      [
        job({ id: "a", project: "web", lastError: "spawn ENOENT" }),
        job({ id: "b", project: "web", lastError: "spawn ENOENT" }),
        job({ id: "c", project: "api", lastError: "rate limited" }),
      ],
      "project"
    );
    const out = renderGroupedErrorBreakdown(groups, "project");
    expect(out).toContain("3 job(s) with errors across 2 project(s)");
    expect(out).toContain("web");
    expect(out).toContain("2 errors");
    expect(out).toContain("spawn ENOENT");
    expect(out).toContain("api");
    expect(out).toContain("1 error");
    expect(out).toContain("rate limited");
  });

  it("caps reasons per group with --limit and shows a hidden footer", () => {
    const groups = groupErrorBreakdown(
      [job({ id: "a", project: "web", lastError: "err one" }), job({ id: "b", project: "web", lastError: "err two" })],
      "project"
    );
    const out = renderGroupedErrorBreakdown(groups, "project", { limit: 1 });
    expect(out).toContain("err one");
    expect(out).not.toContain("err two");
    expect(out).toContain("1 more reason(s) not shown");
  });
});

describe("renderGroupedErrorBreakdownJson", () => {
  it("emits store, scope, groupBy and grouped breakdowns", () => {
    const groups = groupErrorBreakdown(
      [job({ id: "a", project: "web", lastError: "boom" }), job({ id: "b", project: "api", lastError: "boom" })],
      "project"
    );
    const parsed = JSON.parse(
      renderGroupedErrorBreakdownJson(groups, "project", "/tmp/jobs.json", { scopeNote: "since=7d" })
    );
    expect(parsed.store).toBe("/tmp/jobs.json");
    expect(parsed.scope).toBe("since=7d");
    expect(parsed.groupBy).toBe("project");
    expect(parsed.groups.map((g: { key: string }) => g.key).sort()).toEqual(["api", "web"]);
    expect(parsed.groups[0].breakdown.groups[0].signature).toBe("boom");
  });

  it("emits a null scope and empty groups when nothing has errors", () => {
    const parsed = JSON.parse(
      renderGroupedErrorBreakdownJson(groupErrorBreakdown([], "tool"), "tool", "/tmp/jobs.json")
    );
    expect(parsed.scope).toBeNull();
    expect(parsed.groupBy).toBe("tool");
    expect(parsed.groups).toEqual([]);
  });
});
