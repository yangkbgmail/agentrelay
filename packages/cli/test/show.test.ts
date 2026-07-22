import type { RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { formatCommand, renderJobDetail, renderJobDetailJson, renderJobDetailWatchFrame } from "../src/show.js";

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
    createdAt: at(-5 * 60_000),
    updatedAt: at(-4 * 60_000),
    attempts: 2,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("formatCommand", () => {
  it("joins simple args with spaces", () => {
    expect(formatCommand(["claude", "-p", "hi"])).toBe("claude -p hi");
  });

  it("quotes args containing spaces", () => {
    expect(formatCommand(["claude", "-p", "continue the refactor"])).toBe('claude -p "continue the refactor"');
  });

  it("quotes an empty arg and escapes embedded quotes/backslashes", () => {
    expect(formatCommand(["echo", ""])).toBe('echo ""');
    expect(formatCommand(["echo", 'a"b'])).toBe('echo "a\\"b"');
    expect(formatCommand(["echo", "a\\b"])).toBe('echo "a\\\\b"');
  });
});

describe("renderJobDetail", () => {
  it("shows the full id, core fields, and a readable command line", () => {
    const out = renderJobDetail(job(), { now: NOW });
    expect(out).toContain("Job abcdef1234567890");
    expect(out).toContain("project    demo");
    expect(out).toContain("tool       claude-code");
    expect(out).toContain("status     waiting_for_reset");
    expect(out).toContain('command    claude -p "continue the refactor"');
    expect(out).toContain("cwd        /tmp/demo");
    expect(out).toContain("attempts   2");
  });

  it("shows the reset countdown with the absolute time when resetAt is set", () => {
    const out = renderJobDetail(job(), { now: NOW });
    expect(out).toContain("resets in  1h 30m");
    expect(out).toContain(at(90 * 60_000));
  });

  it("omits the reset line when resetAt is null", () => {
    const out = renderJobDetail(job({ resetAt: null }), { now: NOW });
    expect(out).not.toContain("resets in");
  });

  it("annotates the updated timestamp with the lifecycle span", () => {
    const out = renderJobDetail(job(), { now: NOW });
    expect(out).toContain("(1m 0s later)");
  });

  it("marks updated as same-as-created when timestamps match", () => {
    const t = at(0);
    const out = renderJobDetail(job({ createdAt: t, updatedAt: t }), { now: NOW });
    expect(out).toContain("(same as created)");
  });

  it("renders a last error block only when an error is present", () => {
    expect(renderJobDetail(job(), { now: NOW })).not.toContain("last error");
    const out = renderJobDetail(job({ status: "failed", lastError: "boom\nsecond line" }), { now: NOW });
    expect(out).toContain("last error");
    expect(out).toContain("  boom");
    expect(out).toContain("  second line");
  });

  it("renders a last output block only when output was captured", () => {
    expect(renderJobDetail(job(), { now: NOW })).not.toContain("last output");
    const out = renderJobDetail(job({ lastOutputTail: "line A\nline B" }), { now: NOW });
    expect(out).toContain("last output");
    expect(out).toContain("  line A");
    expect(out).toContain("  line B");
  });

  it("emits ANSI codes only when color is enabled", () => {
    expect(renderJobDetail(job(), { now: NOW, color: false })).not.toContain("\x1b[");
    expect(renderJobDetail(job(), { now: NOW, color: true })).toContain("\x1b[");
  });
});

describe("renderJobDetailWatchFrame", () => {
  it("wraps the detail block with a live header and the store path", () => {
    const frame = renderJobDetailWatchFrame(job(), "abcdef12", "/store/jobs.json", 2000, NOW);
    expect(frame).toContain("agentrelay show");
    expect(frame).toContain("every 2s");
    expect(frame).toContain("Ctrl-C to exit");
    expect(frame).toContain("/store/jobs.json");
    // The full detail block is embedded (full id + countdown).
    expect(frame).toContain("Job abcdef1234567890");
    expect(frame).toContain("resets in");
  });

  it("stamps the frame with the injected now (deterministic, no ambient clock)", () => {
    const frame = renderJobDetailWatchFrame(job(), "abcdef12", "/store/jobs.json", 5000, NOW);
    expect(frame).toContain("2026-07-13 00:00:00Z");
    expect(frame).toContain("every 5s");
  });

  it("shows a 'gone' notice instead of crashing when the job is null", () => {
    const frame = renderJobDetailWatchFrame(null, "abcdef12", "/store/jobs.json", 2000, NOW);
    expect(frame).toContain("abcdef12");
    expect(frame).toContain("no longer in the store");
    expect(frame).not.toContain("Job abcdef1234567890");
  });

  it("always emits color (watch view is TTY-only)", () => {
    expect(renderJobDetailWatchFrame(job(), "abcdef12", "/store/jobs.json", 2000, NOW)).toContain("\x1b[");
  });
});

describe("renderJobDetailJson", () => {
  it("wraps the job in a stable snapshot shape", () => {
    const generatedAt = "2026-07-13T00:00:00.000Z";
    const parsed = JSON.parse(renderJobDetailJson(job(), "/store/jobs.json", generatedAt));
    expect(parsed.storePath).toBe("/store/jobs.json");
    expect(parsed.generatedAt).toBe(generatedAt);
    expect(parsed.job.id).toBe("abcdef1234567890");
    expect(parsed.job.command).toEqual(["claude", "-p", "continue the refactor"]);
  });
});
