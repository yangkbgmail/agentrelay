import type { RelayJob } from "@agentrelay/core";
import { describeTools } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { renderTools, renderToolsJson } from "../src/tools.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `abcdef${seq}`,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "queued",
    resetAt: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("renderTools", () => {
  it("lists every adapter with binaries and job counts, even for an empty store", () => {
    const out = renderTools(describeTools([]));
    expect(out).toContain("3 agent adapter(s) registered");
    expect(out).toContain("0 job(s) tracked");
    expect(out).toContain("Claude Code");
    expect(out).toContain("Codex CLI");
    expect(out).toContain("Generic agent");
    // Adapters appear in ALL_TOOLS order.
    expect(out.indexOf("Claude Code")).toBeLessThan(out.indexOf("Codex CLI"));
    expect(out.indexOf("Codex CLI")).toBeLessThan(out.indexOf("Generic agent"));
  });

  it("shows the generic patterns header and the codex-specific extra pattern", () => {
    const out = renderTools(describeTools([]));
    expect(out).toContain("generic patterns (all tools):");
    expect(out).toContain("iso-timestamp");
    // Codex layers a seconds pattern; claude-code/generic are generic only.
    expect(out).toContain("+ codex-relative-seconds");
    expect(out).toContain("generic only");
    expect(out).toContain("binaries:  claude, claude-code");
  });

  it("reports per-tool job counts and how many are active", () => {
    const out = renderTools(
      describeTools([
        job({ tool: "claude-code", status: "queued" }),
        job({ tool: "claude-code", status: "completed" }),
        job({ tool: "codex-cli", status: "waiting_for_reset" }),
      ])
    );
    expect(out).toContain("3 job(s) tracked");
    // claude-code: 2 jobs, 1 active. codex-cli: 1 job, 1 active.
    expect(out).toMatch(/jobs:\s+2 \(1 active\)/);
    expect(out).toMatch(/jobs:\s+1 \(1 active\)/);
  });

  it("echoes a scope note when a filter is active", () => {
    const out = renderTools(describeTools([]), { scopeNote: "status=queued" });
    expect(out).toContain("scope: status=queued");
  });
});

describe("renderToolsJson", () => {
  it("emits a stable envelope with the report and optional scope", () => {
    const report = describeTools([job({ tool: "codex-cli", status: "queued" })]);
    const json = renderToolsJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-12T12:00:00.000Z",
      scope: { statuses: ["queued"] },
      report,
    });
    const parsed = JSON.parse(json);
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-12T12:00:00.000Z");
    expect(parsed.scope).toEqual({ statuses: ["queued"] });
    expect(parsed.report.adapters).toHaveLength(3);
    const codex = parsed.report.adapters.find((a: { tool: string }) => a.tool === "codex-cli");
    expect(codex.jobCount).toBe(1);
    expect(codex.extraPatterns).toEqual(["codex-relative-seconds"]);
  });

  it("omits scope when not provided", () => {
    const json = renderToolsJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-12T12:00:00.000Z",
      report: describeTools([]),
    });
    expect(JSON.parse(json).scope).toBeUndefined();
  });
});
