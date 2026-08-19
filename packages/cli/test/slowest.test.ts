import { buildSlowestReport, type RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_SLOWEST_MESSAGE, renderSlowest, renderSlowestJson } from "../src/slowest.js";

const HOUR = 60 * 60 * 1000;

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job${seq}0000000000`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "completed",
    resetAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function resolved(spanMs: number, overrides: Partial<RelayJob> = {}): RelayJob {
  const created = Date.parse("2026-08-01T00:00:00.000Z");
  return job({
    createdAt: new Date(created).toISOString(),
    updatedAt: new Date(created + spanMs).toISOString(),
    ...overrides,
  });
}

describe("renderSlowest", () => {
  it("shows the empty message when nothing has resolved", () => {
    const report = buildSlowestReport([]);
    expect(renderSlowest(report)).toBe(NO_SLOWEST_MESSAGE);
  });

  it("appends the scope note to the empty message when scoped", () => {
    const report = buildSlowestReport([]);
    const out = renderSlowest(report, { scopeNote: "project=api" });
    expect(out).toContain(NO_SLOWEST_MESSAGE);
    expect(out).toContain("project=api");
  });

  it("renders one row per resolved job, slowest-first, with a header", () => {
    const report = buildSlowestReport([resolved(HOUR), resolved(3 * HOUR), resolved(2 * HOUR)]);
    const out = renderSlowest(report);
    const lines = out.split("\n");
    expect(lines[0]).toContain("ID");
    expect(lines[0]).toContain("PROJECT");
    expect(lines[0]).toContain("TOOL");
    expect(lines[0]).toContain("RESOLUTION");
    // First data row is the 3h job.
    expect(lines[1]).toContain("3h");
    expect(lines[3]).toContain("1h");
  });

  it("summarizes totals, worst, and average in the footer", () => {
    const report = buildSlowestReport([resolved(HOUR), resolved(3 * HOUR)]);
    const out = renderSlowest(report);
    expect(out).toContain("2 resolved jobs");
    expect(out).toContain("worst 3h");
    expect(out).toContain("avg 2h");
  });

  it("reports hidden rows when limited", () => {
    const report = buildSlowestReport([resolved(HOUR), resolved(2 * HOUR), resolved(3 * HOUR)], { limit: 1 });
    const out = renderSlowest(report);
    expect(out).toContain("2 more not shown");
    expect(out.split("\n").filter((l) => l.includes("h"))).toHaveLength(2); // header + 1 row roughly
  });
});

describe("renderSlowestJson", () => {
  it("emits the report, store path, scope, and a generated timestamp", () => {
    const report = buildSlowestReport([resolved(HOUR)]);
    const parsed = JSON.parse(
      renderSlowestJson({
        storePath: "/tmp/jobs.json",
        generatedAt: "2026-08-19T00:00:00.000Z",
        scope: { projects: ["alpha"] },
        report,
      })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-08-19T00:00:00.000Z");
    expect(parsed.scope).toEqual({ projects: ["alpha"] });
    expect(parsed.report.totalResolved).toBe(1);
    expect(parsed.report.entries[0].resolutionMs).toBe(HOUR);
  });

  it("omits scope when none is active", () => {
    const report = buildSlowestReport([]);
    const parsed = JSON.parse(renderSlowestJson({ storePath: "/tmp/jobs.json", report }));
    expect(parsed.scope).toBeUndefined();
    expect(typeof parsed.generatedAt).toBe("string");
  });
});
