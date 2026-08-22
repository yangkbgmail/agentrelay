import { describe, expect, it } from "vitest";
import { type ColorEnv, resolveColorMode } from "./color.js";

describe("resolveColorMode", () => {
  describe("TTY auto-detection (no overriding env)", () => {
    it("colors when stdout is a TTY", () => {
      expect(resolveColorMode({}, { isTTY: true })).toBe(true);
    });

    it("stays plain when stdout is not a TTY (piped / redirected)", () => {
      expect(resolveColorMode({}, { isTTY: false })).toBe(false);
    });

    it("defaults to no color when TTY state is unknown", () => {
      expect(resolveColorMode({})).toBe(false);
    });
  });

  describe("NO_COLOR (https://no-color.org)", () => {
    it("disables color even on a TTY", () => {
      expect(resolveColorMode({ NO_COLOR: "1" }, { isTTY: true })).toBe(false);
    });

    it("disables regardless of the value", () => {
      expect(resolveColorMode({ NO_COLOR: "anything" }, { isTTY: true })).toBe(false);
    });

    it("treats an empty NO_COLOR as unset so it cannot silently disable color", () => {
      expect(resolveColorMode({ NO_COLOR: "" }, { isTTY: true })).toBe(true);
    });
  });

  describe("FORCE_COLOR", () => {
    it("forces color on even when piped (non-TTY)", () => {
      expect(resolveColorMode({ FORCE_COLOR: "1" }, { isTTY: false })).toBe(true);
    });

    it("treats an empty value as force-on (supports-color semantics)", () => {
      expect(resolveColorMode({ FORCE_COLOR: "" }, { isTTY: false })).toBe(true);
    });

    it.each(["0", "false", "no", "off", "OFF", " False "])("reads the falsey value %j as force-off", (value) => {
      expect(resolveColorMode({ FORCE_COLOR: value }, { isTTY: true })).toBe(false);
    });

    it("wins over NO_COLOR when both are set", () => {
      expect(resolveColorMode({ FORCE_COLOR: "1", NO_COLOR: "1" }, { isTTY: false })).toBe(true);
    });
  });

  describe("AGENTRELAY_COLOR app override", () => {
    it("'always' forces color even with NO_COLOR set and no TTY", () => {
      expect(resolveColorMode({ AGENTRELAY_COLOR: "always", NO_COLOR: "1" }, { isTTY: false })).toBe(true);
    });

    it("'never' disables color even with FORCE_COLOR set on a TTY", () => {
      expect(resolveColorMode({ AGENTRELAY_COLOR: "never", FORCE_COLOR: "1" }, { isTTY: true })).toBe(false);
    });

    it("is case-insensitive and ignores surrounding whitespace", () => {
      expect(resolveColorMode({ AGENTRELAY_COLOR: "  AlWaYs  " }, { isTTY: false })).toBe(true);
      expect(resolveColorMode({ AGENTRELAY_COLOR: "NEVER" }, { isTTY: true })).toBe(false);
    });

    it("'auto' falls through to the env standards / TTY detection", () => {
      const env: ColorEnv = { AGENTRELAY_COLOR: "auto" };
      expect(resolveColorMode(env, { isTTY: true })).toBe(true);
      expect(resolveColorMode(env, { isTTY: false })).toBe(false);
      expect(resolveColorMode({ AGENTRELAY_COLOR: "auto", NO_COLOR: "1" }, { isTTY: true })).toBe(false);
    });

    it("ignores an unrecognized value and falls through", () => {
      expect(resolveColorMode({ AGENTRELAY_COLOR: "pink" }, { isTTY: true })).toBe(true);
      expect(resolveColorMode({ AGENTRELAY_COLOR: "pink" }, { isTTY: false })).toBe(false);
    });
  });
});
