import { describe, expect, it } from "vitest";
import { countLines, tailLines } from "./tail.js";

describe("tailLines", () => {
  it("returns the whole text when n is omitted", () => {
    expect(tailLines("a\nb\nc")).toBe("a\nb\nc");
  });

  it("returns the whole text when n is 0 or negative", () => {
    expect(tailLines("a\nb\nc", 0)).toBe("a\nb\nc");
    expect(tailLines("a\nb\nc", -5)).toBe("a\nb\nc");
  });

  it("keeps only the last n lines", () => {
    expect(tailLines("a\nb\nc\nd", 2)).toBe("c\nd");
    expect(tailLines("a\nb\nc\nd", 1)).toBe("d");
  });

  it("returns the whole text when n exceeds the line count", () => {
    expect(tailLines("a\nb", 10)).toBe("a\nb");
  });

  it("treats null/undefined/empty as an empty string", () => {
    expect(tailLines(null)).toBe("");
    expect(tailLines(undefined)).toBe("");
    expect(tailLines("")).toBe("");
    expect(tailLines(null, 5)).toBe("");
  });

  it("preserves a trailing newline as a final empty line", () => {
    // "x\ny\n" -> ["x","y",""] ; last 2 lines are the value + the empty tail.
    expect(tailLines("x\ny\n", 2)).toBe("y\n");
    expect(tailLines("x\ny\n", 1)).toBe("");
  });

  it("handles a single-line tail", () => {
    expect(tailLines("only one line", 1)).toBe("only one line");
    expect(tailLines("only one line", 3)).toBe("only one line");
  });
});

describe("countLines", () => {
  it("counts newline-separated segments", () => {
    expect(countLines("a")).toBe(1);
    expect(countLines("a\nb\nc")).toBe(3);
  });

  it("counts a trailing newline as a final empty line", () => {
    expect(countLines("a\n")).toBe(2);
  });

  it("returns 0 for null/undefined/empty", () => {
    expect(countLines(null)).toBe(0);
    expect(countLines(undefined)).toBe(0);
    expect(countLines("")).toBe(0);
  });
});
