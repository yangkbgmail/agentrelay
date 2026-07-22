import { describe, expect, it } from "vitest";
import { shouldUseColor } from "../src/color.js";

describe("shouldUseColor", () => {
  it("falls back to the TTY signal when nothing else is set", () => {
    expect(shouldUseColor({ isTTY: true })).toBe(true);
    expect(shouldUseColor({ isTTY: false })).toBe(false);
    expect(shouldUseColor({})).toBe(false);
  });

  it("disables colour when the --no-color flag is set, regardless of TTY", () => {
    expect(shouldUseColor({ noColorFlag: true, isTTY: true })).toBe(false);
  });

  it("--no-color wins even over FORCE_COLOR", () => {
    expect(shouldUseColor({ noColorFlag: true, env: { FORCE_COLOR: "1" }, isTTY: false })).toBe(false);
  });

  it("disables colour when NO_COLOR is present and non-empty", () => {
    expect(shouldUseColor({ env: { NO_COLOR: "1" }, isTTY: true })).toBe(false);
    expect(shouldUseColor({ env: { NO_COLOR: "anything" }, isTTY: true })).toBe(false);
  });

  it("ignores an empty NO_COLOR (per the no-color.org spec)", () => {
    expect(shouldUseColor({ env: { NO_COLOR: "" }, isTTY: true })).toBe(true);
    expect(shouldUseColor({ env: { NO_COLOR: "" }, isTTY: false })).toBe(false);
  });

  it("NO_COLOR wins over FORCE_COLOR", () => {
    expect(shouldUseColor({ env: { NO_COLOR: "1", FORCE_COLOR: "1" }, isTTY: false })).toBe(false);
  });

  it("enables colour when FORCE_COLOR is truthy, even without a TTY", () => {
    expect(shouldUseColor({ env: { FORCE_COLOR: "1" }, isTTY: false })).toBe(true);
    expect(shouldUseColor({ env: { FORCE_COLOR: "true" }, isTTY: false })).toBe(true);
  });

  it("treats falsy FORCE_COLOR values as not forcing colour", () => {
    for (const value of ["", "0", "false", "no", "off", "FALSE", "Off"]) {
      expect(shouldUseColor({ env: { FORCE_COLOR: value }, isTTY: false })).toBe(false);
      expect(shouldUseColor({ env: { FORCE_COLOR: value }, isTTY: true })).toBe(true);
    }
  });
});
