import { describe, expect, it } from "vitest";
import { type ColorPreference, normalizeColorPreference, shouldUseColor } from "./color.js";

describe("normalizeColorPreference", () => {
  it("maps undefined (no flag) to auto", () => {
    expect(normalizeColorPreference(undefined)).toBe("auto");
  });

  it("maps commander --no-color (false) to never", () => {
    expect(normalizeColorPreference(false)).toBe("never");
  });

  it("maps a bare --color (true) to always", () => {
    expect(normalizeColorPreference(true)).toBe("always");
  });

  it("accepts explicit string values case/whitespace-insensitively", () => {
    expect(normalizeColorPreference("auto")).toBe("auto");
    expect(normalizeColorPreference("ALWAYS")).toBe("always");
    expect(normalizeColorPreference("  never ")).toBe("never");
  });

  it("throws on an unknown value instead of silently defaulting", () => {
    expect(() => normalizeColorPreference("yes")).toThrow(/Invalid --color value "yes"/);
  });
});

describe("shouldUseColor", () => {
  const on: ColorPreference = "always";
  const off: ColorPreference = "never";

  it("always/never win over everything", () => {
    expect(shouldUseColor({ preference: on, env: { NO_COLOR: "1" }, isTTY: false })).toBe(true);
    expect(shouldUseColor({ preference: off, env: { FORCE_COLOR: "1" }, isTTY: true })).toBe(false);
  });

  it("auto falls back to TTY detection with no env overrides", () => {
    expect(shouldUseColor({ preference: "auto", env: {}, isTTY: true })).toBe(true);
    expect(shouldUseColor({ preference: "auto", env: {}, isTTY: false })).toBe(false);
  });

  it("auto: NO_COLOR (non-empty) disables color even on a TTY", () => {
    expect(shouldUseColor({ preference: "auto", env: { NO_COLOR: "1" }, isTTY: true })).toBe(false);
    expect(shouldUseColor({ preference: "auto", env: { NO_COLOR: "anything" }, isTTY: true })).toBe(false);
  });

  it("auto: an empty NO_COLOR does NOT disable color (per spec)", () => {
    expect(shouldUseColor({ preference: "auto", env: { NO_COLOR: "" }, isTTY: true })).toBe(true);
  });

  it("auto: FORCE_COLOR enables color even when not a TTY", () => {
    expect(shouldUseColor({ preference: "auto", env: { FORCE_COLOR: "1" }, isTTY: false })).toBe(true);
    expect(shouldUseColor({ preference: "auto", env: { FORCE_COLOR: "" }, isTTY: false })).toBe(true);
  });

  it("auto: FORCE_COLOR=0/false is the documented off-switch", () => {
    expect(shouldUseColor({ preference: "auto", env: { FORCE_COLOR: "0" }, isTTY: true })).toBe(false);
    expect(shouldUseColor({ preference: "auto", env: { FORCE_COLOR: "false" }, isTTY: true })).toBe(false);
  });

  it("auto: NO_COLOR takes precedence over FORCE_COLOR", () => {
    expect(shouldUseColor({ preference: "auto", env: { NO_COLOR: "1", FORCE_COLOR: "1" }, isTTY: true })).toBe(false);
  });

  it("defaults preference to auto and isTTY to false when omitted", () => {
    expect(shouldUseColor({})).toBe(false);
    expect(shouldUseColor({ env: { FORCE_COLOR: "1" } })).toBe(true);
  });
});
