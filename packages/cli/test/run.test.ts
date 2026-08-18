import { describe, expect, it } from "vitest";
import { previewRun, type RunPreview } from "../src/commands.js";
import { renderRunPreview, renderRunPreviewJson } from "../src/run.js";

function preview(overrides: Partial<RunPreview> = {}): RunPreview {
  return {
    command: ["claude", "-p", "continue the refactor"],
    cwd: "/home/user/project",
    project: "project",
    tool: "claude-code",
    displayName: "Claude Code",
    toolSource: "inferred",
    storePath: "/home/user/.agentrelay/jobs.json",
    extraPatterns: ["claude-usage-limit-epoch"],
    resetHorizonMs: 8 * 24 * 60 * 60_000,
    ...overrides,
  };
}

describe("previewRun", () => {
  it("infers the tool adapter from the command's argv[0]", () => {
    const p = previewRun({ command: ["codex", "exec", "fix it"], cwd: "/x/web", env: {} });
    expect(p.tool).toBe("codex-cli");
    expect(p.displayName).toBe("Codex CLI");
    expect(p.toolSource).toBe("inferred");
    expect(p.extraPatterns).toContain("codex-relative-seconds");
  });

  it("marks an explicit --tool as the source, overriding inference", () => {
    const p = previewRun({ command: ["claude", "-p", "hi"], tool: "generic", cwd: "/x", env: {} });
    expect(p.tool).toBe("generic");
    expect(p.toolSource).toBe("explicit");
    expect(p.extraPatterns).toEqual([]);
  });

  it("falls back to the generic adapter for an unrecognized command", () => {
    const p = previewRun({ command: ["my-agent", "go"], cwd: "/x", env: {} });
    expect(p.tool).toBe("generic");
    expect(p.toolSource).toBe("default");
    expect(p.extraPatterns).toEqual([]);
  });

  it("derives the project label from the cwd's last segment", () => {
    expect(previewRun({ command: ["claude"], cwd: "/home/me/my-app", env: {} }).project).toBe("my-app");
  });

  it("honors an explicit --project override", () => {
    const p = previewRun({ command: ["claude"], cwd: "/home/me/src", project: "backend", env: {} });
    expect(p.project).toBe("backend");
  });

  it("uses the given store path", () => {
    expect(previewRun({ command: ["claude"], cwd: "/x", storePath: "/tmp/s.json", env: {} }).storePath).toBe(
      "/tmp/s.json"
    );
  });

  it("reflects the reset-horizon env: default set, disabled null", () => {
    expect(previewRun({ command: ["claude"], cwd: "/x", env: {} }).resetHorizonMs).toBeGreaterThan(0);
    expect(
      previewRun({ command: ["claude"], cwd: "/x", env: { AGENTRELAY_MAX_RESET_HORIZON: "off" } }).resetHorizonMs
    ).toBeNull();
  });
});

describe("renderRunPreview", () => {
  it("shows the command, cwd, project, tool source, store, patterns, and horizon", () => {
    const out = renderRunPreview(preview());
    expect(out).toContain("agentrelay run --dry-run");
    expect(out).toContain("nothing was executed");
    expect(out).toContain('command    claude -p "continue the refactor"');
    expect(out).toContain("cwd        /home/user/project");
    expect(out).toContain("project    project");
    expect(out).toContain("tool       claude-code");
    expect(out).toContain("inferred from command");
    expect(out).toContain("store      /home/user/.agentrelay/jobs.json");
    expect(out).toContain("claude-usage-limit-epoch");
    expect(out).toContain("+ generic patterns");
    expect(out).toContain("8d 0h");
  });

  it("notes generic-patterns-only when the adapter has no extra patterns", () => {
    const out = renderRunPreview(preview({ extraPatterns: [], tool: "generic", displayName: "Generic agent" }));
    expect(out).toContain("generic patterns only");
    expect(out).not.toContain("+ generic patterns");
  });

  it("explains each tool source phrasing", () => {
    expect(renderRunPreview(preview({ toolSource: "explicit" }))).toContain("from --tool");
    expect(renderRunPreview(preview({ toolSource: "default", tool: "generic" }))).toContain("generic fallback");
  });

  it("says the horizon guard is off when null", () => {
    const out = renderRunPreview(preview({ resetHorizonMs: null }));
    expect(out).toContain("off (far-future resets are not dropped)");
  });

  it("emits ANSI codes only when color is enabled", () => {
    expect(renderRunPreview(preview(), { color: false })).not.toContain("\x1b[");
    expect(renderRunPreview(preview(), { color: true })).toContain("\x1b[");
  });
});

describe("renderRunPreviewJson", () => {
  it("wraps the preview in a stable dry-run snapshot shape", () => {
    const parsed = JSON.parse(renderRunPreviewJson(preview(), "2026-08-18T00:00:00.000Z"));
    expect(parsed.dryRun).toBe(true);
    expect(parsed.generatedAt).toBe("2026-08-18T00:00:00.000Z");
    expect(parsed.preview.tool).toBe("claude-code");
    expect(parsed.preview.command).toEqual(["claude", "-p", "continue the refactor"]);
    expect(parsed.preview.toolSource).toBe("inferred");
  });
});
