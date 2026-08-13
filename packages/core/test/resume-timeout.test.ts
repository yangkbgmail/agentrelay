import { describe, expect, it } from "vitest";
import { DEFAULT_RESUME_TIMEOUT_MS, normalizeResumeTimeoutMs, resumeTimeoutFromEnv } from "../src/resume-timeout.js";

describe("normalizeResumeTimeoutMs", () => {
  it("passes through a positive integer", () => {
    expect(normalizeResumeTimeoutMs(30_000)).toBe(30_000);
  });

  it("floors a fractional value", () => {
    expect(normalizeResumeTimeoutMs(1500.9)).toBe(1500);
  });

  it("disables (0) for undefined / NaN / Infinity / zero / negative", () => {
    expect(normalizeResumeTimeoutMs(undefined)).toBe(DEFAULT_RESUME_TIMEOUT_MS);
    expect(normalizeResumeTimeoutMs(Number.NaN)).toBe(DEFAULT_RESUME_TIMEOUT_MS);
    expect(normalizeResumeTimeoutMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_RESUME_TIMEOUT_MS);
    expect(normalizeResumeTimeoutMs(0)).toBe(DEFAULT_RESUME_TIMEOUT_MS);
    expect(normalizeResumeTimeoutMs(-5)).toBe(DEFAULT_RESUME_TIMEOUT_MS);
  });

  it("defaults to disabled", () => {
    expect(DEFAULT_RESUME_TIMEOUT_MS).toBe(0);
  });
});

describe("resumeTimeoutFromEnv", () => {
  it("parses a human duration", () => {
    expect(resumeTimeoutFromEnv({ AGENTRELAY_RESUME_TIMEOUT: "30m" })).toBe(30 * 60_000);
    expect(resumeTimeoutFromEnv({ AGENTRELAY_RESUME_TIMEOUT: "2h" })).toBe(2 * 3_600_000);
    expect(resumeTimeoutFromEnv({ AGENTRELAY_RESUME_TIMEOUT: "90s" })).toBe(90_000);
    expect(resumeTimeoutFromEnv({ AGENTRELAY_RESUME_TIMEOUT: "500ms" })).toBe(500);
  });

  it("disables the watchdog when unset or blank", () => {
    expect(resumeTimeoutFromEnv({})).toBe(DEFAULT_RESUME_TIMEOUT_MS);
    expect(resumeTimeoutFromEnv({ AGENTRELAY_RESUME_TIMEOUT: "" })).toBe(DEFAULT_RESUME_TIMEOUT_MS);
    expect(resumeTimeoutFromEnv({ AGENTRELAY_RESUME_TIMEOUT: "   " })).toBe(DEFAULT_RESUME_TIMEOUT_MS);
  });

  it("disables the watchdog for an unparseable or non-positive duration (a typo never kills long runs)", () => {
    expect(resumeTimeoutFromEnv({ AGENTRELAY_RESUME_TIMEOUT: "soon" })).toBe(DEFAULT_RESUME_TIMEOUT_MS);
    expect(resumeTimeoutFromEnv({ AGENTRELAY_RESUME_TIMEOUT: "10" })).toBe(DEFAULT_RESUME_TIMEOUT_MS); // no unit
    expect(resumeTimeoutFromEnv({ AGENTRELAY_RESUME_TIMEOUT: "0s" })).toBe(DEFAULT_RESUME_TIMEOUT_MS);
    expect(resumeTimeoutFromEnv({ AGENTRELAY_RESUME_TIMEOUT: "-5m" })).toBe(DEFAULT_RESUME_TIMEOUT_MS);
  });
});
