import type { RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { formatCommand, renderJobDetail, renderJobDetailJson } from "../src/logs.js";

const NOW = Date.parse("2026-07-13T00:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "abcdef1234567890",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue the refactor"],
    cwd: "/tmp/demo",
    status: "waiting_for_reset",
    resetAt: at(90 * 60_000),
    createdAt: at(-1000),
    updatedAt: at(-500),
    attempts: 2,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("formatCommand", () => {
  it("leaves plain tokens bare", () => {
    expect(formatCommand(["claude", "-p", "hello"])).toBe("claude -p hello");
  });

  it("quotes tokens that contain whitespace", () => {
    expect(formatCommand(["claude", "-p", "continue the refactor"])).toBe("claude -p 'continue the refactor'");
  });

  it("escapes embedded single quotes", () => {
    expect(formatCommand(["echo", "it's fine"])).toBe("echo 'it'\\''s fine'");
  });

  it("renders an empty token as ''", () => {
    expect(formatCommand(["a", ""])).toBe("a ''");
  });

  it("returns '-' for an empty argv", () => {
    expect(formatCommand([])).toBe("-");
  });
});

describe("renderJobDetail", () => {
  it("shows the full id, project, command, and cwd (no truncation)", () => {
    const out = renderJobDetail(job({ id: "abcdef12-3456-7890-abcd-ef1234567890" }), { now: NOW });
    expect(out).toContain("Job abcdef12-3456-7890-abcd-ef1234567890");
    expect(out).toContain("project    demo");
    expect(out).toContain("cwd        /tmp/demo");
    expect(out).toContain("claude -p 'continue the refactor'");
  });

  it("shows the reset countdown alongside the raw reset timestamp", () => {
    const out = renderJobDetail(job(), { now: NOW });
    expect(out).toContain(`resets in  1h 30m (${at(90 * 60_000)})`);
  });

  it("shows '-' for reset when the job has none", () => {
    const out = renderJobDetail(job({ status: "completed", resetAt: null }), { now: NOW });
    expect(out).toMatch(/resets in\s+-/);
  });

  it("prints the last error and output tail verbatim, indented", () => {
    const out = renderJobDetail(job({ lastError: "boom: exit 1", lastOutputTail: "line one\nline two" }), { now: NOW });
    expect(out).toContain("last error:");
    expect(out).toContain("  boom: exit 1");
    expect(out).toContain("last output:");
    expect(out).toContain("  line one\n  line two");
  });

  it("shows '-' blocks when error/output are absent", () => {
    const out = renderJobDetail(job({ lastError: null, lastOutputTail: null }), { now: NOW });
    // Both the error and the output blocks fall back to a single "  -" line.
    expect(out.match(/^ {2}-$/gm)?.length).toBe(2);
  });

  it("emits no ANSI escapes when color is off (default)", () => {
    const out = renderJobDetail(job(), { now: NOW });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes present
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("emits ANSI escapes when color is on", () => {
    const out = renderJobDetail(job(), { now: NOW, color: true });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI escapes present
    expect(out).toMatch(/\x1b\[/);
  });
});

describe("renderJobDetailJson", () => {
  it("wraps the job in a storePath/generatedAt envelope", () => {
    const parsed = JSON.parse(renderJobDetailJson(job(), "/store/jobs.json", at(0)));
    expect(parsed.storePath).toBe("/store/jobs.json");
    expect(parsed.generatedAt).toBe(at(0));
    expect(parsed.job.id).toBe("abcdef1234567890");
    expect(parsed.job.command).toEqual(["claude", "-p", "continue the refactor"]);
  });
});
