import { describe, expect, it } from "vitest";
import { GENERIC_PATTERN_NAMES } from "./parser.js";
import { describeTools } from "./tools.js";
import type { AgentTool, JobStatus, RelayJob } from "./types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "proj",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "queued",
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("describeTools", () => {
  it("lists every registered adapter in ALL_TOOLS order, even with no jobs", () => {
    const report = describeTools([]);
    expect(report.totalJobs).toBe(0);
    expect(report.adapters.map((a) => a.tool)).toEqual(["claude-code", "codex-cli", "generic"]);
    for (const adapter of report.adapters) {
      expect(adapter.jobCount).toBe(0);
      expect(adapter.activeCount).toBe(0);
    }
  });

  it("exposes the generic pattern names shared by all adapters", () => {
    const report = describeTools([]);
    expect(report.genericPatterns).toEqual(GENERIC_PATTERN_NAMES);
    expect(report.genericPatterns.length).toBeGreaterThan(0);
    // Returns a copy, not the module-level array (defensive against mutation).
    expect(report.genericPatterns).not.toBe(GENERIC_PATTERN_NAMES);
  });

  it("surfaces adapter binaries and tool-specific extra patterns", () => {
    const report = describeTools([]);
    const byTool = Object.fromEntries(report.adapters.map((a) => [a.tool, a]));

    expect(byTool["claude-code"].displayName).toBe("Claude Code");
    expect(byTool["claude-code"].binaries).toEqual(["claude", "claude-code"]);
    expect(byTool["claude-code"].extraPatterns).toEqual([]);

    // Codex layers a seconds-granularity pattern on top of the generic ones.
    expect(byTool["codex-cli"].binaries).toEqual(["codex", "codex-cli"]);
    expect(byTool["codex-cli"].extraPatterns).toEqual(["codex-relative-seconds"]);

    expect(byTool.generic.binaries).toEqual([]);
    expect(byTool.generic.extraPatterns).toEqual([]);
  });

  it("counts jobs per tool and how many are active", () => {
    const active: JobStatus[] = ["queued", "waiting_for_reset", "resuming"];
    const terminal: JobStatus[] = ["completed", "failed", "cancelled"];
    const jobs: RelayJob[] = [
      ...active.map((status) => job({ tool: "claude-code", status })),
      ...terminal.map((status) => job({ tool: "claude-code", status })),
      job({ tool: "codex-cli", status: "waiting_for_reset" }),
    ];

    const report = describeTools(jobs);
    const byTool = Object.fromEntries(report.adapters.map((a) => [a.tool, a]));

    expect(report.totalJobs).toBe(7);
    expect(byTool["claude-code"].jobCount).toBe(6);
    expect(byTool["claude-code"].activeCount).toBe(3);
    expect(byTool["codex-cli"].jobCount).toBe(1);
    expect(byTool["codex-cli"].activeCount).toBe(1);
    expect(byTool.generic.jobCount).toBe(0);
  });

  it("counts a foreign tool id in totalJobs but attributes it to no adapter", () => {
    const jobs: RelayJob[] = [
      job({ tool: "bogus-tool" as AgentTool, status: "queued" }),
      job({ tool: "claude-code", status: "queued" }),
    ];
    const report = describeTools(jobs);
    expect(report.totalJobs).toBe(2);
    const sumAttributed = report.adapters.reduce((n, a) => n + a.jobCount, 0);
    expect(sumAttributed).toBe(1); // only the claude-code job lands in a bucket
  });

  it("does not mutate the passed job list", () => {
    const jobs = [job(), job({ tool: "codex-cli" })];
    const snapshot = JSON.parse(JSON.stringify(jobs));
    describeTools(jobs);
    expect(jobs).toEqual(snapshot);
  });
});
