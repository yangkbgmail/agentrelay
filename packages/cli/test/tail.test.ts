import type { RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { renderJobTail, renderJobTailJson } from "../src/tail.js";

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "abcdef1234567890",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue the refactor"],
    cwd: "/tmp/demo",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:10:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: "line one\nline two\nline three",
    ...overrides,
  };
}

describe("renderJobTail", () => {
  it("returns the full captured output when no line limit is given", () => {
    const r = renderJobTail(job());
    expect(r.empty).toBe(false);
    expect(r.output).toBe("line one\nline two\nline three");
    expect(r.lines).toBe(3);
  });

  it("keeps only the last n lines when limited", () => {
    const r = renderJobTail(job(), 2);
    expect(r.output).toBe("line two\nline three");
    expect(r.lines).toBe(2);
  });

  it("returns the whole output when n exceeds the line count", () => {
    const r = renderJobTail(job(), 99);
    expect(r.output).toBe("line one\nline two\nline three");
    expect(r.lines).toBe(3);
  });

  it("reports empty for a null tail (job not finished)", () => {
    const r = renderJobTail(job({ lastOutputTail: null, status: "waiting_for_reset" }));
    expect(r.empty).toBe(true);
    expect(r.output).toBe("");
    expect(r.lines).toBe(0);
  });

  it("reports empty for an empty-string tail", () => {
    const r = renderJobTail(job({ lastOutputTail: "" }));
    expect(r.empty).toBe(true);
  });
});

describe("renderJobTailJson", () => {
  it("emits id/project/status/lines/output with a fixed generatedAt", () => {
    const parsed = JSON.parse(renderJobTailJson(job(), undefined, "2026-07-13T01:00:00.000Z"));
    expect(parsed).toEqual({
      generatedAt: "2026-07-13T01:00:00.000Z",
      id: "abcdef1234567890",
      project: "demo",
      status: "completed",
      lines: 3,
      output: "line one\nline two\nline three",
    });
  });

  it("applies the line limit to the JSON output", () => {
    const parsed = JSON.parse(renderJobTailJson(job(), 1, "2026-07-13T01:00:00.000Z"));
    expect(parsed.output).toBe("line three");
    expect(parsed.lines).toBe(1);
  });

  it("emits an empty output and 0 lines for a null tail", () => {
    const parsed = JSON.parse(renderJobTailJson(job({ lastOutputTail: null }), undefined, "2026-07-13T01:00:00.000Z"));
    expect(parsed.output).toBe("");
    expect(parsed.lines).toBe(0);
  });
});
