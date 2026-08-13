import { describe, expect, it } from "vitest";
import { resolveColorPreference, shouldUseColor } from "./color.js";

describe("resolveColorPreference", () => {
  it("returns null when neither NO_COLOR nor FORCE_COLOR is set", () => {
    expect(resolveColorPreference({})).toBeNull();
  });

  it("disables color when NO_COLOR is present and non-empty (any value)", () => {
    expect(resolveColorPreference({ NO_COLOR: "1" })).toBe(false);
    expect(resolveColorPreference({ NO_COLOR: "true" })).toBe(false);
    expect(resolveColorPreference({ NO_COLOR: "please" })).toBe(false);
  });

  it("treats an empty NO_COLOR as unset (avoids an accidental blank var stripping color)", () => {
    expect(resolveColorPreference({ NO_COLOR: "" })).toBeNull();
  });

  it("forces color on when FORCE_COLOR is set to a truthy value", () => {
    expect(resolveColorPreference({ FORCE_COLOR: "1" })).toBe(true);
    expect(resolveColorPreference({ FORCE_COLOR: "always" })).toBe(true);
  });

  it("treats a blank FORCE_COLOR as force-on (supports-color convention)", () => {
    expect(resolveColorPreference({ FORCE_COLOR: "" })).toBe(true);
  });

  it("forces color off when FORCE_COLOR is 0 or false (case/space-insensitive)", () => {
    expect(resolveColorPreference({ FORCE_COLOR: "0" })).toBe(false);
    expect(resolveColorPreference({ FORCE_COLOR: "false" })).toBe(false);
    expect(resolveColorPreference({ FORCE_COLOR: " FALSE " })).toBe(false);
  });

  it("gives FORCE_COLOR precedence over NO_COLOR when both are set", () => {
    expect(resolveColorPreference({ FORCE_COLOR: "1", NO_COLOR: "1" })).toBe(true);
    expect(resolveColorPreference({ FORCE_COLOR: "0", NO_COLOR: "1" })).toBe(false);
  });
});

describe("shouldUseColor", () => {
  it("defers to the TTY flag when no override applies", () => {
    expect(shouldUseColor({}, true)).toBe(true);
    expect(shouldUseColor({}, false)).toBe(false);
  });

  it("defaults isTTY to false when omitted", () => {
    expect(shouldUseColor({})).toBe(false);
  });

  it("lets NO_COLOR strip color even on a TTY", () => {
    expect(shouldUseColor({ NO_COLOR: "1" }, true)).toBe(false);
  });

  it("lets FORCE_COLOR keep color even when not a TTY (piped output)", () => {
    expect(shouldUseColor({ FORCE_COLOR: "1" }, false)).toBe(true);
  });

  it("lets FORCE_COLOR=0 disable color even on a TTY", () => {
    expect(shouldUseColor({ FORCE_COLOR: "0" }, true)).toBe(false);
  });
});
