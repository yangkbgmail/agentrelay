import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESUME_GRACE_MS,
  normalizeResumeGraceMs,
  RESUME_GRACE_ENV,
  resumeCutoff,
  resumeGraceMsFromEnv,
} from "../src/grace.js";

describe("normalizeResumeGraceMs", () => {
  it("passes through a positive whole-ms value", () => {
    expect(normalizeResumeGraceMs(30_000)).toBe(30_000);
  });

  it("floors a fractional value", () => {
    expect(normalizeResumeGraceMs(1500.9)).toBe(1500);
  });

  it("collapses undefined/null to the default (off)", () => {
    expect(normalizeResumeGraceMs(undefined)).toBe(DEFAULT_RESUME_GRACE_MS);
    expect(normalizeResumeGraceMs(null)).toBe(DEFAULT_RESUME_GRACE_MS);
    expect(DEFAULT_RESUME_GRACE_MS).toBe(0);
  });

  it("rejects non-positive and non-finite values (never advances a resume)", () => {
    expect(normalizeResumeGraceMs(0)).toBe(0);
    expect(normalizeResumeGraceMs(-5000)).toBe(0);
    expect(normalizeResumeGraceMs(Number.NaN)).toBe(0);
    expect(normalizeResumeGraceMs(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("resumeGraceMsFromEnv", () => {
  it("parses a duration string into ms", () => {
    expect(resumeGraceMsFromEnv({ [RESUME_GRACE_ENV]: "30s" })).toBe(30_000);
    expect(resumeGraceMsFromEnv({ [RESUME_GRACE_ENV]: "2m" })).toBe(120_000);
    expect(resumeGraceMsFromEnv({ [RESUME_GRACE_ENV]: "  500ms " })).toBe(500);
  });

  it("returns the default (off) when the var is missing or blank", () => {
    expect(resumeGraceMsFromEnv({})).toBe(0);
    expect(resumeGraceMsFromEnv({ [RESUME_GRACE_ENV]: "" })).toBe(0);
    expect(resumeGraceMsFromEnv({ [RESUME_GRACE_ENV]: "   " })).toBe(0);
  });

  it("returns the default (off) for an unparseable or non-positive duration", () => {
    expect(resumeGraceMsFromEnv({ [RESUME_GRACE_ENV]: "soon" })).toBe(0);
    expect(resumeGraceMsFromEnv({ [RESUME_GRACE_ENV]: "0s" })).toBe(0);
    expect(resumeGraceMsFromEnv({ [RESUME_GRACE_ENV]: "-1m" })).toBe(0);
  });
});

describe("resumeCutoff", () => {
  const ref = new Date("2026-08-16T15:00:00.000Z");

  it("shifts the reference back by the grace", () => {
    expect(resumeCutoff(ref, 30_000).toISOString()).toBe("2026-08-16T14:59:30.000Z");
  });

  it("returns the same instant when grace is 0 (default path allocates nothing)", () => {
    expect(resumeCutoff(ref, 0)).toBe(ref);
  });

  it("treats a non-positive grace as 0", () => {
    expect(resumeCutoff(ref, -1000)).toBe(ref);
  });
});
