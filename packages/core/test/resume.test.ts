import { describe, expect, it } from "vitest";
import { DEFAULT_RESUME_BUFFER_MS, resumeBufferMsFromEnv } from "../src/resume.js";

describe("resumeBufferMsFromEnv", () => {
  it("defaults to 0 when the env var is unset", () => {
    expect(resumeBufferMsFromEnv({})).toBe(DEFAULT_RESUME_BUFFER_MS);
    expect(DEFAULT_RESUME_BUFFER_MS).toBe(0);
  });

  it("parses a human duration into milliseconds", () => {
    expect(resumeBufferMsFromEnv({ AGENTRELAY_RESUME_BUFFER: "30s" })).toBe(30_000);
    expect(resumeBufferMsFromEnv({ AGENTRELAY_RESUME_BUFFER: "2m" })).toBe(120_000);
    expect(resumeBufferMsFromEnv({ AGENTRELAY_RESUME_BUFFER: "500ms" })).toBe(500);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(resumeBufferMsFromEnv({ AGENTRELAY_RESUME_BUFFER: "  45s  " })).toBe(45_000);
  });

  it("treats an empty/whitespace value as the default (buffer off)", () => {
    expect(resumeBufferMsFromEnv({ AGENTRELAY_RESUME_BUFFER: "" })).toBe(0);
    expect(resumeBufferMsFromEnv({ AGENTRELAY_RESUME_BUFFER: "   " })).toBe(0);
  });

  it("falls back to the default on an unparseable value (a typo can never shorten the wait)", () => {
    // No unit, unknown unit, and non-numeric all fall through to 0.
    expect(resumeBufferMsFromEnv({ AGENTRELAY_RESUME_BUFFER: "30" })).toBe(0);
    expect(resumeBufferMsFromEnv({ AGENTRELAY_RESUME_BUFFER: "soon" })).toBe(0);
    expect(resumeBufferMsFromEnv({ AGENTRELAY_RESUME_BUFFER: "1 week" })).toBe(0);
  });

  it("rejects a negative duration (parseDuration returns null for those)", () => {
    expect(resumeBufferMsFromEnv({ AGENTRELAY_RESUME_BUFFER: "-30s" })).toBe(0);
  });

  it("accepts an explicit 0s (buffer disabled on purpose)", () => {
    expect(resumeBufferMsFromEnv({ AGENTRELAY_RESUME_BUFFER: "0s" })).toBe(0);
  });
});
