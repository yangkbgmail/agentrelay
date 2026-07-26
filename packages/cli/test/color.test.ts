import { describe, expect, it } from "vitest";
import { type ColorFlag, colorFlagFromProgram, resolveColor } from "../src/color.js";

describe("resolveColor precedence", () => {
  it("colorizes when stdout is a TTY and nothing overrides it", () => {
    expect(resolveColor({ isTTY: true })).toBe(true);
  });

  it("does not colorize when stdout is not a TTY", () => {
    expect(resolveColor({ isTTY: false })).toBe(false);
    expect(resolveColor({})).toBe(false);
  });

  it("an explicit --no-color flag wins over a TTY", () => {
    expect(resolveColor({ flag: "never", isTTY: true })).toBe(false);
  });

  it("an explicit --color flag wins over a non-TTY", () => {
    expect(resolveColor({ flag: "always", isTTY: false })).toBe(true);
  });

  it("an explicit flag wins over NO_COLOR / FORCE_COLOR env", () => {
    expect(resolveColor({ flag: "always", isTTY: false, env: { NO_COLOR: "1" } })).toBe(true);
    expect(resolveColor({ flag: "never", isTTY: true, env: { FORCE_COLOR: "1" } })).toBe(false);
  });

  it("NO_COLOR present and non-empty disables color regardless of value or TTY", () => {
    expect(resolveColor({ isTTY: true, env: { NO_COLOR: "1" } })).toBe(false);
    expect(resolveColor({ isTTY: true, env: { NO_COLOR: "anything" } })).toBe(false);
    expect(resolveColor({ isTTY: true, env: { NO_COLOR: "0" } })).toBe(false);
  });

  it("an empty NO_COLOR is treated as unset (per no-color.org)", () => {
    expect(resolveColor({ isTTY: true, env: { NO_COLOR: "" } })).toBe(true);
    expect(resolveColor({ isTTY: false, env: { NO_COLOR: "" } })).toBe(false);
  });

  it("NO_COLOR wins over FORCE_COLOR when both are set", () => {
    expect(resolveColor({ isTTY: false, env: { NO_COLOR: "1", FORCE_COLOR: "1" } })).toBe(false);
  });

  it("FORCE_COLOR forces color on even without a TTY", () => {
    expect(resolveColor({ isTTY: false, env: { FORCE_COLOR: "1" } })).toBe(true);
    expect(resolveColor({ isTTY: false, env: { FORCE_COLOR: "3" } })).toBe(true);
    expect(resolveColor({ isTTY: false, env: { FORCE_COLOR: "" } })).toBe(true);
    expect(resolveColor({ isTTY: false, env: { FORCE_COLOR: "true" } })).toBe(true);
  });

  it('FORCE_COLOR of "0"/"false" disables color', () => {
    expect(resolveColor({ isTTY: true, env: { FORCE_COLOR: "0" } })).toBe(false);
    expect(resolveColor({ isTTY: true, env: { FORCE_COLOR: "false" } })).toBe(false);
    expect(resolveColor({ isTTY: true, env: { FORCE_COLOR: "FALSE" } })).toBe(false);
  });
});

describe("colorFlagFromProgram", () => {
  // Minimal stand-in for the parts of a commander Command that the helper reads.
  function fakeProgram(source: string | undefined, value: unknown) {
    return {
      getOptionValueSource: () => source,
      opts: () => ({ color: value }),
    } as unknown as Parameters<typeof colorFlagFromProgram>[0];
  }

  it('returns "auto" when the color option was not set on the command line', () => {
    expect(colorFlagFromProgram(fakeProgram(undefined, undefined))).toBe("auto");
    expect(colorFlagFromProgram(fakeProgram("default", true))).toBe("auto");
    expect(colorFlagFromProgram(fakeProgram("env", false))).toBe("auto");
  });

  it('returns "always" for an explicit --color', () => {
    expect(colorFlagFromProgram(fakeProgram("cli", true))).toBe("always");
  });

  it('returns "never" for an explicit --no-color', () => {
    expect(colorFlagFromProgram(fakeProgram("cli", false))).toBe("never");
  });

  it("tolerates a program without getOptionValueSource", () => {
    const p = { opts: () => ({ color: true }) } as unknown as Parameters<typeof colorFlagFromProgram>[0];
    const flag: ColorFlag = colorFlagFromProgram(p);
    expect(flag).toBe("auto");
  });
});
