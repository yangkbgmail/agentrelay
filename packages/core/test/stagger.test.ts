import { describe, expect, it } from "vitest";
import { applyResumeStagger, computeResumeStaggerMs, resumeStaggerMsFromEnv } from "../src/stagger.js";

describe("computeResumeStaggerMs", () => {
  it("returns 0 when stagger is disabled (<= 0)", () => {
    expect(computeResumeStaggerMs(0, () => 0.5)).toBe(0);
    expect(computeResumeStaggerMs(-100, () => 0.5)).toBe(0);
  });

  it("floors rng*staggerMs into [0, staggerMs)", () => {
    expect(computeResumeStaggerMs(60_000, () => 0)).toBe(0);
    expect(computeResumeStaggerMs(60_000, () => 0.5)).toBe(30_000);
    // Just under the top of the window.
    expect(computeResumeStaggerMs(60_000, () => 0.999999)).toBe(59_999);
  });

  it("clamps a misbehaving rng (>=1) to at most staggerMs", () => {
    expect(computeResumeStaggerMs(60_000, () => 1)).toBe(60_000);
  });

  it("treats a NaN rng result as no offset", () => {
    expect(computeResumeStaggerMs(60_000, () => Number.NaN)).toBe(0);
  });
});

describe("applyResumeStagger", () => {
  const reset = "2026-07-23T17:00:00.000Z";

  it("returns the input unchanged when stagger is disabled", () => {
    expect(applyResumeStagger(reset, 0, () => 0.5)).toBe(reset);
  });

  it("shifts the reset forward by the computed offset", () => {
    // 60s window, rng 0.5 -> +30s
    expect(applyResumeStagger(reset, 60_000, () => 0.5)).toBe("2026-07-23T17:00:30.000Z");
  });

  it("never shifts earlier than the true reset (offset is non-negative)", () => {
    expect(applyResumeStagger(reset, 60_000, () => 0)).toBe(reset);
  });

  it("leaves an unparseable timestamp untouched rather than corrupting it", () => {
    expect(applyResumeStagger("not-a-date", 60_000, () => 0.5)).toBe("not-a-date");
  });
});

describe("resumeStaggerMsFromEnv", () => {
  it("is disabled (0) when unset or empty", () => {
    expect(resumeStaggerMsFromEnv({})).toBe(0);
    expect(resumeStaggerMsFromEnv({ AGENTRELAY_RESUME_STAGGER: "  " })).toBe(0);
  });

  it("parses a duration string into ms", () => {
    expect(resumeStaggerMsFromEnv({ AGENTRELAY_RESUME_STAGGER: "30s" })).toBe(30_000);
    expect(resumeStaggerMsFromEnv({ AGENTRELAY_RESUME_STAGGER: "2m" })).toBe(120_000);
    expect(resumeStaggerMsFromEnv({ AGENTRELAY_RESUME_STAGGER: "500ms" })).toBe(500);
  });

  it("treats 0s and unparseable/non-positive values as disabled", () => {
    expect(resumeStaggerMsFromEnv({ AGENTRELAY_RESUME_STAGGER: "0s" })).toBe(0);
    expect(resumeStaggerMsFromEnv({ AGENTRELAY_RESUME_STAGGER: "nonsense" })).toBe(0);
  });
});
