import { describe, expect, it } from "vitest";
import { scanRateLimits } from "./scan.js";

// A fixed reference time so relative-duration resolutions are deterministic.
const NOW = new Date("2026-07-13T00:00:00.000Z");

describe("scanRateLimits", () => {
  it("returns an empty shape for empty input", () => {
    expect(scanRateLimits("", { now: NOW })).toEqual({
      tool: "generic",
      totalLines: 0,
      matchedLines: 0,
      matches: [],
      patterns: [],
    });
  });

  it("reports no matches when nothing looks like a rate limit", () => {
    const result = scanRateLimits("building...\ncompiling...\ndone\n", { now: NOW });
    expect(result.totalLines).toBe(3);
    expect(result.matchedLines).toBe(0);
    expect(result.matches).toEqual([]);
    expect(result.patterns).toEqual([]);
  });

  it("does not count a single trailing newline as an extra line", () => {
    expect(scanRateLimits("a\nb\n", { now: NOW }).totalLines).toBe(2);
    expect(scanRateLimits("a\nb", { now: NOW }).totalLines).toBe(2);
  });

  it("handles CRLF line endings", () => {
    const result = scanRateLimits("noise\r\ntry again in 5 minutes\r\nmore noise\r\n", { now: NOW });
    expect(result.totalLines).toBe(3);
    expect(result.matchedLines).toBe(1);
    expect(result.matches[0].line).toBe(2);
    expect(result.matches[0].resetAt).toBe("2026-07-13T00:05:00.000Z");
  });

  it("finds a detection and records its 1-based line number", () => {
    const text = ["starting job", "reset at 2026-07-13T05:00:00Z", "shutting down"].join("\n");
    const result = scanRateLimits(text, { now: NOW });
    expect(result.totalLines).toBe(3);
    expect(result.matchedLines).toBe(1);
    expect(result.matches).toEqual([
      {
        line: 2,
        text: "reset at 2026-07-13T05:00:00Z",
        pattern: "iso-timestamp",
        rawMatch: "reset at 2026-07-13T05:00:00Z",
        resetAt: "2026-07-13T05:00:00.000Z",
      },
    ]);
    expect(result.patterns).toEqual([{ pattern: "iso-timestamp", count: 1 }]);
  });

  it("collects every matching line in input order", () => {
    const text = [
      "try again in 5 minutes", // relative-duration
      "ordinary log line",
      "try again in 10 minutes", // relative-duration
      "reset at 2026-07-13T06:00:00Z", // iso-timestamp
    ].join("\n");
    const result = scanRateLimits(text, { now: NOW });
    expect(result.matchedLines).toBe(3);
    expect(result.matches.map((m) => m.line)).toEqual([1, 3, 4]);
    expect(result.matches.map((m) => m.resetAt)).toEqual([
      "2026-07-13T00:05:00.000Z",
      "2026-07-13T00:10:00.000Z",
      "2026-07-13T06:00:00.000Z",
    ]);
  });

  it("ranks the pattern-frequency table by count desc then name asc", () => {
    const text = [
      "try again in 1 minutes", // relative-duration
      "try again in 2 minutes", // relative-duration
      "reset at 2026-07-13T06:00:00Z", // iso-timestamp
      "try again in 3 minutes", // relative-duration
    ].join("\n");
    const result = scanRateLimits(text, { now: NOW });
    expect(result.patterns).toEqual([
      { pattern: "relative-duration", count: 3 },
      { pattern: "iso-timestamp", count: 1 },
    ]);
  });

  it("uses the tool adapter's extra patterns (Codex seconds)", () => {
    const text = "Rate limit reached. Please try again in 20s\n";
    // The generic parser has no seconds pattern; the codex adapter adds one.
    expect(scanRateLimits(text, { now: NOW, tool: "generic" }).matchedLines).toBe(0);
    const codex = scanRateLimits(text, { now: NOW, tool: "codex-cli" });
    expect(codex.tool).toBe("codex-cli");
    expect(codex.matchedLines).toBe(1);
    expect(codex.matches[0].pattern).toBe("codex-relative-seconds");
    expect(codex.matches[0].resetAt).toBe("2026-07-13T00:00:20.000Z");
  });

  it("trims trailing whitespace from the recorded line text", () => {
    const result = scanRateLimits("reset at 2026-07-13T05:00:00Z   \n", { now: NOW });
    expect(result.matches[0].text).toBe("reset at 2026-07-13T05:00:00Z");
  });
});
