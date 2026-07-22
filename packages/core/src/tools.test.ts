import { describe, expect, it } from "vitest";
import { countJobsByTool, describeAdapters, summarizeTools } from "./tools.js";
import type { AgentTool, JobStatus, RelayJob } from "./types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "proj",
    tool: "claude-code" as AgentTool,
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "completed" as JobStatus,
    resetAt: null,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("describeAdapters", () => {
  it("lists every registered adapter in ALL_TOOLS order", () => {
    const infos = describeAdapters();
    expect(infos.map((i) => i.tool)).toEqual(["claude-code", "codex-cli", "generic"]);
  });

  it("exposes binaries and display names", () => {
    const claude = describeAdapters().find((i) => i.tool === "claude-code");
    expect(claude?.displayName).toBe("Claude Code");
    expect(claude?.binaries).toEqual(["claude", "claude-code"]);
  });

  it("reports tool-specific pattern names (codex has a seconds pattern, others none)", () => {
    const infos = describeAdapters();
    expect(infos.find((i) => i.tool === "codex-cli")?.patternNames).toEqual(["codex-relative-seconds"]);
    expect(infos.find((i) => i.tool === "claude-code")?.patternNames).toEqual([]);
    expect(infos.find((i) => i.tool === "generic")?.patternNames).toEqual([]);
  });

  it("returns a defensive copy of binaries (mutation does not leak into the registry)", () => {
    const first = describeAdapters().find((i) => i.tool === "claude-code");
    first?.binaries.push("evil");
    const second = describeAdapters().find((i) => i.tool === "claude-code");
    expect(second?.binaries).toEqual(["claude", "claude-code"]);
  });
});

describe("countJobsByTool", () => {
  it("tallies jobs by their tool field", () => {
    const counts = countJobsByTool([
      job({ tool: "claude-code" as AgentTool }),
      job({ tool: "claude-code" as AgentTool }),
      job({ tool: "codex-cli" as AgentTool }),
    ]);
    expect(counts).toEqual({ "claude-code": 2, "codex-cli": 1 });
  });

  it("returns an empty object for no jobs", () => {
    expect(countJobsByTool([])).toEqual({});
  });

  it("keeps unrecognized tool strings rather than dropping them", () => {
    const counts = countJobsByTool([job({ tool: "future-agent" as AgentTool })]);
    expect(counts).toEqual({ "future-agent": 1 });
  });
});

describe("summarizeTools", () => {
  it("includes every registered adapter even when unused (jobCount 0)", () => {
    const report = summarizeTools([]);
    expect(report.totalJobs).toBe(0);
    expect(report.tools.map((t) => t.tool)).toEqual(["claude-code", "codex-cli", "generic"]);
    expect(report.tools.every((t) => t.jobCount === 0)).toBe(true);
    expect(report.tools.every((t) => t.adapter !== null)).toBe(true);
  });

  it("cross-references job counts against the store", () => {
    const report = summarizeTools([
      job({ tool: "claude-code" as AgentTool }),
      job({ tool: "codex-cli" as AgentTool }),
      job({ tool: "codex-cli" as AgentTool }),
    ]);
    expect(report.totalJobs).toBe(3);
    const byTool = Object.fromEntries(report.tools.map((t) => [t.tool, t.jobCount]));
    expect(byTool).toEqual({ "claude-code": 1, "codex-cli": 2, generic: 0 });
  });

  it("appends unregistered store-only tools after the adapters, sorted", () => {
    const report = summarizeTools([
      job({ tool: "zeta-agent" as AgentTool }),
      job({ tool: "alpha-agent" as AgentTool }),
      job({ tool: "claude-code" as AgentTool }),
    ]);
    // First the three registered adapters (stable order), then unknowns sorted.
    expect(report.tools.map((t) => t.tool)).toEqual([
      "claude-code",
      "codex-cli",
      "generic",
      "alpha-agent",
      "zeta-agent",
    ]);
    const unknowns = report.tools.filter((t) => t.adapter === null);
    expect(unknowns.map((t) => [t.tool, t.jobCount])).toEqual([
      ["alpha-agent", 1],
      ["zeta-agent", 1],
    ]);
  });
});
