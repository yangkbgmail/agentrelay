import { computeSlowest, type RelayJob, type SlowestReport } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_SLOWEST_MESSAGE, renderSlowest, renderSlowestJson } from "../src/slowest.js";

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "abcdef1234567890",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T01:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function report(jobs: RelayJob[], limit?: number): SlowestReport {
  return computeSlowest(jobs, limit);
}

describe("renderSlowest", () => {
  it("shows the empty message when nothing has resolved", () => {
    expect(renderSlowest(report([]))).toBe(NO_SLOWEST_MESSAGE);
  });

  it("appends the scope note to the empty message when scoped", () => {
    const out = renderSlowest(report([]), { scopeNote: "project=ghost" });
    expect(out).toContain(NO_SLOWEST_MESSAGE);
    expect(out).toContain("scope: project=ghost");
  });

  it("renders one row per resolved job, slowest first, with ranks", () => {
    const out = renderSlowest(
      report([
        job({ id: "fast0000", project: "fast-app", updatedAt: "2026-07-30T00:30:00.000Z" }),
        job({ id: "slow0000", project: "slow-app", updatedAt: "2026-07-30T04:00:00.000Z" }),
      ])
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("PROJECT");
    expect(lines[0]).toContain("RESOLUTION");
    // slow-app took longer, so it ranks above fast-app.
    expect(out.indexOf("slow-app")).toBeLessThan(out.indexOf("fast-app"));
    expect(out).toContain("1  ");
    expect(out).toContain("2  ");
  });

  it("reuses the shared duration format for the resolution span", () => {
    const out = renderSlowest(report([job({ updatedAt: "2026-07-30T04:12:00.000Z" })]));
    expect(out).toContain("4h 12m");
  });

  it("shows the job status in each row", () => {
    const out = renderSlowest(report([job({ status: "failed" })]));
    expect(out).toContain("failed");
  });

  it("footer reports totals and hidden rows under a limit", () => {
    const jobs = [
      job({ id: "j1", updatedAt: "2026-07-30T04:00:00.000Z" }),
      job({ id: "j2", updatedAt: "2026-07-30T03:00:00.000Z" }),
      job({ id: "j3", updatedAt: "2026-07-30T02:00:00.000Z" }),
    ];
    const out = renderSlowest(report(jobs, 1));
    expect(out).toContain("3 resolved jobs");
    expect(out).toContain("2 more not shown");
  });

  it("does not emit ANSI escapes when color is off", () => {
    const out = renderSlowest(report([job()]), { color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no escapes.
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe("renderSlowestJson", () => {
  it("emits the store path, report, and honest totals", () => {
    const r = report([job({ id: "j1", updatedAt: "2026-07-30T04:00:00.000Z" })], 1);
    const parsed = JSON.parse(
      renderSlowestJson({ storePath: "/tmp/jobs.json", generatedAt: "2026-07-30T10:00:00.000Z", report: r })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.report.entries).toHaveLength(1);
    expect(parsed.report.entries[0].job.id).toBe("j1");
    expect(parsed.report.entries[0].resolutionMs).toBe(4 * 60 * 60 * 1000);
    expect(parsed.report.totalResolved).toBe(1);
  });

  it("includes the scope when one is passed", () => {
    const parsed = JSON.parse(
      renderSlowestJson({
        storePath: "/tmp/jobs.json",
        scope: { statuses: ["failed"] },
        report: report([]),
      })
    );
    expect(parsed.scope).toEqual({ statuses: ["failed"] });
  });
});
