import { describe, expect, it } from "vitest";
import { summarizeAdapters } from "./tools.js";
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

describe("summarizeAdapters", () => {
  it("lists every registered adapter even with no jobs", () => {
    const summary = summarizeAdapters([]);
    expect(summary.total).toBe(0);
    expect(summary.unknownTools).toEqual([]);
    expect(summary.adapters.map((a) => a.tool)).toEqual(["claude-code", "codex-cli", "generic"]);
    for (const a of summary.adapters) {
      expect(a.jobs).toBe(0);
      expect(a.activeJobs).toBe(0);
    }
  });

  it("exposes each adapter's recognized binaries and pattern names from the registry", () => {
    const summary = summarizeAdapters([]);
    const byTool = Object.fromEntries(summary.adapters.map((a) => [a.tool, a]));

    expect(byTool["claude-code"].displayName).toBe("Claude Code");
    expect(byTool["claude-code"].binaries).toEqual(["claude", "claude-code"]);
    expect(byTool["claude-code"].patternCount).toBe(0);
    expect(byTool["claude-code"].patternNames).toEqual([]);

    // Codex contributes a tool-specific seconds pattern the generic parser misses.
    expect(byTool["codex-cli"].binaries).toEqual(["codex", "codex-cli"]);
    expect(byTool["codex-cli"].patternCount).toBe(1);
    expect(byTool["codex-cli"].patternNames).toEqual(["codex-relative-seconds"]);

    // The generic adapter matches no binary and injects no extra patterns.
    expect(byTool.generic.binaries).toEqual([]);
    expect(byTool.generic.patternCount).toBe(0);
  });

  it("counts jobs per tool and splits out the active subset", () => {
    const jobs = [
      job({ tool: "claude-code", status: "queued" }),
      job({ tool: "claude-code", status: "completed" }),
      job({ tool: "claude-code", status: "waiting_for_reset" }),
      job({ tool: "codex-cli", status: "resuming" }),
      job({ tool: "generic", status: "failed" }),
    ];
    const summary = summarizeAdapters(jobs);
    const byTool = Object.fromEntries(summary.adapters.map((a) => [a.tool, a]));

    expect(summary.total).toBe(5);
    // queued + waiting_for_reset are active; completed is not.
    expect(byTool["claude-code"].jobs).toBe(3);
    expect(byTool["claude-code"].activeJobs).toBe(2);
    expect(byTool["codex-cli"].jobs).toBe(1);
    expect(byTool["codex-cli"].activeJobs).toBe(1);
    expect(byTool.generic.jobs).toBe(1);
    expect(byTool.generic.activeJobs).toBe(0);
    expect(summary.unknownTools).toEqual([]);
  });

  it("collects unregistered tool ids into unknownTools ranked by count then name", () => {
    const jobs = [
      job({ tool: "made-up" as AgentTool }),
      job({ tool: "made-up" as AgentTool }),
      job({ tool: "another" as AgentTool }),
      job({ tool: "claude-code" }),
    ];
    const summary = summarizeAdapters(jobs);

    // Known tools never leak into the unknown bucket.
    expect(summary.adapters.find((a) => a.tool === "claude-code")?.jobs).toBe(1);
    // Ranked by count desc, then name asc.
    expect(summary.unknownTools).toEqual([
      { tool: "made-up", jobs: 2 },
      { tool: "another", jobs: 1 },
    ]);
  });

  it("treats every ACTIVE status as active and terminal statuses as inactive", () => {
    const statuses: JobStatus[] = ["queued", "waiting_for_reset", "resuming", "completed", "failed", "cancelled"];
    const jobs = statuses.map((status) => job({ tool: "generic", status }));
    const generic = summarizeAdapters(jobs).adapters.find((a) => a.tool === "generic");
    expect(generic?.jobs).toBe(6);
    expect(generic?.activeJobs).toBe(3);
  });

  it("returns fresh binary/pattern arrays that don't alias the registry", () => {
    const summary = summarizeAdapters([]);
    const codex = summary.adapters.find((a) => a.tool === "codex-cli");
    codex?.binaries.push("mutated");
    codex?.patternNames.push("mutated");
    // A second call must be unaffected by the mutation above.
    const again = summarizeAdapters([]).adapters.find((a) => a.tool === "codex-cli");
    expect(again?.binaries).toEqual(["codex", "codex-cli"]);
    expect(again?.patternNames).toEqual(["codex-relative-seconds"]);
  });
});
