import { describe, expect, it } from "vitest";
import { computeErrorBreakdown, errorSignature, groupErrorBreakdown } from "../src/errors.js";
import type { RelayJob } from "../src/types.js";

function job(overrides: Partial<RelayJob>): RelayJob {
  return {
    id: "id-1",
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

describe("errorSignature", () => {
  it("returns null for a null error", () => {
    expect(errorSignature(null)).toBeNull();
  });

  it("returns null for whitespace-only errors", () => {
    expect(errorSignature("")).toBeNull();
    expect(errorSignature("   \n\t  ")).toBeNull();
  });

  it("takes the first non-empty line", () => {
    expect(errorSignature("\n\nspawn ENOENT\nat Object.<anonymous>")).toBe("spawn ENOENT");
  });

  it("handles CRLF line endings", () => {
    expect(errorSignature("boom\r\ntrace")).toBe("boom");
  });

  it("collapses internal whitespace runs to single spaces", () => {
    expect(errorSignature("exit   code\t\t1")).toBe("exit code 1");
  });

  it("trims leading/trailing whitespace", () => {
    expect(errorSignature("   padded error   ")).toBe("padded error");
  });

  it("caps overly long signatures with an ellipsis", () => {
    const long = `${"x".repeat(500)}`;
    const sig = errorSignature(long) as string;
    expect(sig.length).toBe(200);
    expect(sig.endsWith("…")).toBe(true);
  });
});

describe("computeErrorBreakdown", () => {
  it("returns an empty breakdown for no jobs", () => {
    const result = computeErrorBreakdown([]);
    expect(result.totalWithErrors).toBe(0);
    expect(result.distinctSignatures).toBe(0);
    expect(result.groups).toEqual([]);
  });

  it("skips jobs without an actionable error", () => {
    const result = computeErrorBreakdown([
      job({ id: "a", lastError: null }),
      job({ id: "b", lastError: "   " }),
      job({ id: "c", lastError: "real failure" }),
    ]);
    expect(result.totalWithErrors).toBe(1);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].jobIds).toEqual(["c"]);
  });

  it("groups jobs that share a normalized signature", () => {
    const result = computeErrorBreakdown([
      job({ id: "a", lastError: "spawn ENOENT" }),
      job({ id: "b", lastError: "spawn ENOENT\nat foo" }),
      job({ id: "c", lastError: "spawn   ENOENT" }),
    ]);
    expect(result.distinctSignatures).toBe(1);
    expect(result.groups[0].count).toBe(3);
    expect(result.groups[0].jobIds).toEqual(["a", "b", "c"]);
  });

  it("ranks groups by count desc, then signature asc", () => {
    const result = computeErrorBreakdown([
      job({ id: "a", lastError: "zeta error" }),
      job({ id: "b", lastError: "alpha error" }),
      job({ id: "c", lastError: "alpha error" }),
      job({ id: "d", lastError: "beta error" }),
    ]);
    expect(result.groups.map((g) => [g.signature, g.count])).toEqual([
      ["alpha error", 2],
      ["beta error", 1],
      ["zeta error", 1],
    ]);
  });

  it("preserves the first job's raw error as the sample", () => {
    const raw = "spawn ENOENT\n  at Object.<anonymous> (/a/b.js:1:1)";
    const result = computeErrorBreakdown([
      job({ id: "a", lastError: raw }),
      job({ id: "b", lastError: "spawn ENOENT\ndifferent tail" }),
    ]);
    expect(result.groups[0].sample).toBe(raw);
  });

  it("collects distinct statuses within a group, first-seen order", () => {
    const result = computeErrorBreakdown([
      job({ id: "a", status: "failed", lastError: "boom" }),
      job({ id: "b", status: "cancelled", lastError: "boom" }),
      job({ id: "c", status: "failed", lastError: "boom" }),
    ]);
    expect(result.groups[0].statuses).toEqual(["failed", "cancelled"]);
  });
});

describe("groupErrorBreakdown", () => {
  it("returns an empty array for no jobs", () => {
    expect(groupErrorBreakdown([], "project")).toEqual([]);
  });

  it("partitions errors by project and nests a full breakdown per group", () => {
    const groups = groupErrorBreakdown(
      [
        job({ id: "a", project: "web", lastError: "spawn ENOENT" }),
        job({ id: "b", project: "web", lastError: "spawn ENOENT" }),
        job({ id: "c", project: "api", lastError: "exit code 1" }),
      ],
      "project"
    );
    expect(groups.map((g) => [g.key, g.count])).toEqual([
      ["web", 2],
      ["api", 1],
    ]);
    expect(groups[0].breakdown.distinctSignatures).toBe(1);
    expect(groups[0].breakdown.groups[0].jobIds).toEqual(["a", "b"]);
  });

  it("groups by tool and by status too", () => {
    const byTool = groupErrorBreakdown(
      [
        job({ id: "a", tool: "codex-cli", lastError: "boom" }),
        job({ id: "b", tool: "claude-code", lastError: "boom" }),
      ],
      "tool"
    );
    expect(byTool.map((g) => g.key).sort()).toEqual(["claude-code", "codex-cli"]);

    const byStatus = groupErrorBreakdown(
      [job({ id: "a", status: "failed", lastError: "boom" }), job({ id: "b", status: "cancelled", lastError: "boom" })],
      "status"
    );
    expect(byStatus.map((g) => g.key).sort()).toEqual(["cancelled", "failed"]);
  });

  it("drops groups whose jobs carry no actionable error", () => {
    const groups = groupErrorBreakdown(
      [
        job({ id: "a", project: "web", lastError: null }),
        job({ id: "b", project: "web", lastError: "   " }),
        job({ id: "c", project: "api", lastError: "real failure" }),
      ],
      "project"
    );
    expect(groups.map((g) => g.key)).toEqual(["api"]);
    expect(groups[0].count).toBe(1);
  });

  it("ranks groups by error count desc, then key asc", () => {
    const groups = groupErrorBreakdown(
      [
        job({ id: "a", project: "zeta", lastError: "boom" }),
        job({ id: "b", project: "alpha", lastError: "boom" }),
        job({ id: "c", project: "alpha", lastError: "boom" }),
        job({ id: "d", project: "beta", lastError: "boom" }),
      ],
      "project"
    );
    expect(groups.map((g) => [g.key, g.count])).toEqual([
      ["alpha", 2],
      ["beta", 1],
      ["zeta", 1],
    ]);
  });

  it("does not mutate the input job list", () => {
    const jobs = [job({ id: "a", project: "web", lastError: "boom" })];
    const snapshot = JSON.stringify(jobs);
    groupErrorBreakdown(jobs, "project");
    expect(JSON.stringify(jobs)).toBe(snapshot);
  });
});
