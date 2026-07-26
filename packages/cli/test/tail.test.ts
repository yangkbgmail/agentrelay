import type { RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { lastLines, renderTail, renderTailJson } from "../src/tail.js";

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "abcdef1234567890",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "waiting_for_reset",
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:01:00.000Z",
    attempts: 0,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("lastLines", () => {
  it("returns empty string for a nullish or empty tail", () => {
    expect(lastLines(null)).toBe("");
    expect(lastLines(undefined)).toBe("");
    expect(lastLines("")).toBe("");
  });

  it("returns the whole tail when no line limit is given", () => {
    expect(lastLines("a\nb\nc")).toBe("a\nb\nc");
    expect(lastLines("a\nb\nc", 0)).toBe("a\nb\nc");
    expect(lastLines("a\nb\nc", -1)).toBe("a\nb\nc");
  });

  it("keeps only the last N lines", () => {
    expect(lastLines("l1\nl2\nl3\nl4", 2)).toBe("l3\nl4");
    expect(lastLines("l1\nl2\nl3\nl4", 1)).toBe("l4");
  });

  it("returns the whole tail when it has fewer lines than N", () => {
    expect(lastLines("only\ntwo", 5)).toBe("only\ntwo");
  });

  it("preserves a trailing newline and \\r\\n endings verbatim", () => {
    expect(lastLines("a\r\nb\r\nc\r\n", 2)).toBe("b\r\nc\r\n");
    expect(lastLines("a\nb\nc\n", 1)).toBe("c\n");
  });
});

describe("renderTail", () => {
  it("returns the raw tail verbatim", () => {
    expect(renderTail(job({ lastOutputTail: "hit your usage limit\nresets at 5pm" }))).toBe(
      "hit your usage limit\nresets at 5pm"
    );
  });

  it("returns empty string when no output was captured", () => {
    expect(renderTail(job({ lastOutputTail: null }))).toBe("");
  });

  it("applies the line limit", () => {
    expect(renderTail(job({ lastOutputTail: "one\ntwo\nthree" }), { lines: 1 })).toBe("three");
  });
});

describe("renderTailJson", () => {
  it("reports the id, tail and hasOutput=true", () => {
    const out = JSON.parse(renderTailJson(job({ lastOutputTail: "some output" }), {}, "2026-07-13T00:00:00.000Z"));
    expect(out).toEqual({
      generatedAt: "2026-07-13T00:00:00.000Z",
      id: "abcdef1234567890",
      hasOutput: true,
      tail: "some output",
    });
  });

  it("reports hasOutput=false with an empty tail when nothing was captured", () => {
    const out = JSON.parse(renderTailJson(job({ lastOutputTail: null }), {}, "2026-07-13T00:00:00.000Z"));
    expect(out.hasOutput).toBe(false);
    expect(out.tail).toBe("");
  });

  it("applies the line limit to the json tail", () => {
    const out = JSON.parse(renderTailJson(job({ lastOutputTail: "a\nb\nc" }), { lines: 2 }));
    expect(out.tail).toBe("b\nc");
  });
});
