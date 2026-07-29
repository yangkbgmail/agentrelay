import { describe, expect, it } from "vitest";
import { DEFAULT_RESUME_STAGGER_MS, resumeStaggerMsFromEnv, staggerResetAt } from "../src/stagger.js";

const BASE = "2026-07-23T12:00:00.000Z";
const baseMs = new Date(BASE).getTime();

describe("staggerResetAt", () => {
  it("returns resetAt unchanged when the window is 0 (default, deterministic)", () => {
    const rng = () => 0.99; // would move it if consulted
    expect(staggerResetAt(BASE, 0, rng)).toBe(BASE);
    expect(staggerResetAt(BASE, DEFAULT_RESUME_STAGGER_MS, rng)).toBe(BASE);
  });

  it("returns resetAt unchanged when no rng is supplied", () => {
    expect(staggerResetAt(BASE, 60_000)).toBe(BASE);
  });

  it("returns resetAt unchanged for a non-positive window even with an rng", () => {
    const rng = () => 0.5;
    expect(staggerResetAt(BASE, -5000, rng)).toBe(BASE);
  });

  it("pushes the reset time forward by rng() * window", () => {
    const rng = () => 0.5;
    const out = staggerResetAt(BASE, 60_000, rng);
    expect(new Date(out).getTime()).toBe(baseMs + 30_000);
  });

  it("never moves the reset time earlier — offset is always added", () => {
    for (const r of [0, 0.01, 0.25, 0.5, 0.75, 0.999]) {
      const out = new Date(staggerResetAt(BASE, 120_000, () => r)).getTime();
      expect(out).toBeGreaterThanOrEqual(baseMs);
      expect(out).toBeLessThanOrEqual(baseMs + 120_000);
    }
  });

  it("caps the offset at the window (rng just under 1)", () => {
    const out = staggerResetAt(BASE, 60_000, () => 0.999999);
    // round(0.999999 * 60000) = 60000
    expect(new Date(out).getTime()).toBe(baseMs + 60_000);
  });

  it("returns resetAt unchanged when the offset rounds to 0", () => {
    // 0 * window = 0 → identity (same string back, no re-serialization drift)
    expect(staggerResetAt(BASE, 60_000, () => 0)).toBe(BASE);
  });

  it("spreads two same-window jobs apart with different rng draws", () => {
    const a = new Date(staggerResetAt(BASE, 60_000, () => 0.1)).getTime();
    const b = new Date(staggerResetAt(BASE, 60_000, () => 0.9)).getTime();
    expect(a).not.toBe(b);
    expect(b - a).toBe(48_000); // (0.9 - 0.1) * 60000
  });

  it("leaves an unparseable resetAt as-is", () => {
    expect(staggerResetAt("not-a-date", 60_000, () => 0.5)).toBe("not-a-date");
  });
});

describe("resumeStaggerMsFromEnv", () => {
  it("defaults to 0 (off) when unset or blank", () => {
    expect(resumeStaggerMsFromEnv({})).toBe(0);
    expect(resumeStaggerMsFromEnv({ AGENTRELAY_RESUME_STAGGER: "" })).toBe(0);
    expect(resumeStaggerMsFromEnv({ AGENTRELAY_RESUME_STAGGER: "   " })).toBe(0);
  });

  it("parses duration strings into milliseconds", () => {
    expect(resumeStaggerMsFromEnv({ AGENTRELAY_RESUME_STAGGER: "30s" })).toBe(30_000);
    expect(resumeStaggerMsFromEnv({ AGENTRELAY_RESUME_STAGGER: "2m" })).toBe(120_000);
    expect(resumeStaggerMsFromEnv({ AGENTRELAY_RESUME_STAGGER: "500ms" })).toBe(500);
  });

  it("falls back to 0 for unparseable or non-positive durations (typo disables, never throws)", () => {
    expect(resumeStaggerMsFromEnv({ AGENTRELAY_RESUME_STAGGER: "banana" })).toBe(0);
    expect(resumeStaggerMsFromEnv({ AGENTRELAY_RESUME_STAGGER: "0s" })).toBe(0);
    expect(resumeStaggerMsFromEnv({ AGENTRELAY_RESUME_STAGGER: "0" })).toBe(0);
  });
});
