import { describe, expect, it } from "vitest";
import { maxRuntimeMsFromEnv, normalizeMaxRuntimeMs } from "../src/runtime.js";

describe("maxRuntimeMsFromEnv", () => {
  it("is off by default (unset / empty)", () => {
    expect(maxRuntimeMsFromEnv({})).toBeNull();
    expect(maxRuntimeMsFromEnv({ AGENTRELAY_MAX_RUNTIME: "" })).toBeNull();
    expect(maxRuntimeMsFromEnv({ AGENTRELAY_MAX_RUNTIME: "   " })).toBeNull();
  });

  it("parses a positive duration string", () => {
    expect(maxRuntimeMsFromEnv({ AGENTRELAY_MAX_RUNTIME: "30m" })).toBe(30 * 60_000);
    expect(maxRuntimeMsFromEnv({ AGENTRELAY_MAX_RUNTIME: "2h" })).toBe(2 * 60 * 60_000);
    expect(maxRuntimeMsFromEnv({ AGENTRELAY_MAX_RUNTIME: "90s" })).toBe(90_000);
    expect(maxRuntimeMsFromEnv({ AGENTRELAY_MAX_RUNTIME: "500ms" })).toBe(500);
  });

  it("treats explicit off-words as no limit", () => {
    for (const word of ["0", "off", "none", "disabled", "no", "OFF", "None"]) {
      expect(maxRuntimeMsFromEnv({ AGENTRELAY_MAX_RUNTIME: word })).toBeNull();
    }
  });

  it("treats an unparseable or non-positive value as no limit (a typo never starts killing runs)", () => {
    expect(maxRuntimeMsFromEnv({ AGENTRELAY_MAX_RUNTIME: "banana" })).toBeNull();
    expect(maxRuntimeMsFromEnv({ AGENTRELAY_MAX_RUNTIME: "-5m" })).toBeNull();
  });
});

describe("normalizeMaxRuntimeMs", () => {
  it("keeps a positive finite number", () => {
    expect(normalizeMaxRuntimeMs(1000)).toBe(1000);
    expect(normalizeMaxRuntimeMs(1)).toBe(1);
  });

  it("collapses null/undefined/zero/negative/non-finite to null", () => {
    expect(normalizeMaxRuntimeMs(null)).toBeNull();
    expect(normalizeMaxRuntimeMs(undefined)).toBeNull();
    expect(normalizeMaxRuntimeMs(0)).toBeNull();
    expect(normalizeMaxRuntimeMs(-1)).toBeNull();
    expect(normalizeMaxRuntimeMs(Number.NaN)).toBeNull();
    expect(normalizeMaxRuntimeMs(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
