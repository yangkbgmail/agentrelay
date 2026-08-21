import type { RateLimitDetection } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { describeDetection, MATCH_PREVIEW_MAX, truncateMatch } from "../lib/provenance";

describe("truncateMatch", () => {
  it("collapses internal whitespace and trims the ends", () => {
    expect(truncateMatch("  usage   limit\n  reached  ")).toBe("usage limit reached");
  });

  it("collapses newlines from multi-line agent output", () => {
    expect(truncateMatch("try again\nin 30 minutes")).toBe("try again in 30 minutes");
  });

  it("leaves a short string untouched", () => {
    expect(truncateMatch("reset at 5pm")).toBe("reset at 5pm");
  });

  it("elides past max with a trailing ellipsis and never exceeds max", () => {
    const raw = "x".repeat(200);
    const out = truncateMatch(raw, 10);
    expect(out).toBe(`${"x".repeat(9)}…`);
    expect(out.length).toBe(10);
  });

  it("defaults to MATCH_PREVIEW_MAX", () => {
    const raw = "y".repeat(MATCH_PREVIEW_MAX + 50);
    expect(truncateMatch(raw).length).toBe(MATCH_PREVIEW_MAX);
  });

  it("returns empty for a non-positive max", () => {
    expect(truncateMatch("anything", 0)).toBe("");
    expect(truncateMatch("anything", -5)).toBe("");
  });
});

describe("describeDetection", () => {
  const detection: RateLimitDetection = {
    pattern: "claude-code-epoch",
    rawMatch: "usage limit reached|1734567890",
    resetAt: "2026-08-21T05:00:00.000Z",
    detectedAt: "2026-08-21T00:00:00.000Z",
  };

  it("flattens the detection into a display view", () => {
    const view = describeDetection(detection);
    expect(view.pattern).toBe("claude-code-epoch");
    expect(view.matchPreview).toBe("usage limit reached|1734567890");
    expect(view.truncated).toBe(false);
    expect(view.resetAt).toBe(detection.resetAt);
    expect(view.detectedAt).toBe(detection.detectedAt);
  });

  it("flags a truncated match", () => {
    const long: RateLimitDetection = { ...detection, rawMatch: "reset ".repeat(60) };
    const view = describeDetection(long);
    expect(view.truncated).toBe(true);
    expect(view.matchPreview.endsWith("…")).toBe(true);
    expect(view.matchPreview.length).toBe(MATCH_PREVIEW_MAX);
  });
});
