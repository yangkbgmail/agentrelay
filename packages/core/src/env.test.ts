import { describe, expect, it } from "vitest";
import { buildJobEnv, captureEnvFrom, isValidEnvKey, parseEnvAssignment, resolveSpawnEnv } from "./env.js";

describe("isValidEnvKey", () => {
  it("accepts valid identifiers", () => {
    for (const k of ["PATH", "_x", "ANTHROPIC_BASE_URL", "A1", "__proto"]) {
      expect(isValidEnvKey(k)).toBe(true);
    }
  });

  it("rejects invalid names", () => {
    for (const k of ["", "1ABC", "A-B", "A B", "A=B", "A.B", "한글"]) {
      expect(isValidEnvKey(k)).toBe(false);
    }
  });
});

describe("parseEnvAssignment", () => {
  it("splits on the first = only", () => {
    expect(parseEnvAssignment("KEY=a=b=c")).toEqual({ key: "KEY", value: "a=b=c" });
  });

  it("allows an empty value", () => {
    expect(parseEnvAssignment("KEY=")).toEqual({ key: "KEY", value: "" });
  });

  it("preserves URL/token values verbatim", () => {
    expect(parseEnvAssignment("ANTHROPIC_BASE_URL=https://x.test/v1?a=1")).toEqual({
      key: "ANTHROPIC_BASE_URL",
      value: "https://x.test/v1?a=1",
    });
  });

  it("throws when there is no =", () => {
    expect(() => parseEnvAssignment("NOPE")).toThrow(/expected KEY=VALUE/);
  });

  it("throws on an invalid key", () => {
    expect(() => parseEnvAssignment("1BAD=x")).toThrow(/Invalid --env key/);
    expect(() => parseEnvAssignment("=x")).toThrow(/Invalid --env key/);
  });
});

describe("captureEnvFrom", () => {
  it("keeps only names that are set in the source", () => {
    const src = { A: "1", B: "2", C: undefined };
    expect(captureEnvFrom(["A", "C", "MISSING"], src)).toEqual({ A: "1" });
  });

  it("captures an empty-string value (set but empty)", () => {
    expect(captureEnvFrom(["A"], { A: "" })).toEqual({ A: "" });
  });

  it("returns an empty map when nothing matches", () => {
    expect(captureEnvFrom(["X"], {})).toEqual({});
  });

  it("throws on an invalid name", () => {
    expect(() => captureEnvFrom(["A-B"], { "A-B": "1" })).toThrow(/Invalid --env-from name/);
  });
});

describe("buildJobEnv", () => {
  it("returns undefined when nothing is captured", () => {
    expect(buildJobEnv([], {})).toBeUndefined();
  });

  it("merges captures and assignments", () => {
    expect(buildJobEnv([{ key: "B", value: "2" }], { A: "1" })).toEqual({ A: "1", B: "2" });
  });

  it("lets an explicit assignment win over a captured snapshot of the same key", () => {
    expect(buildJobEnv([{ key: "A", value: "explicit" }], { A: "captured" })).toEqual({ A: "explicit" });
  });
});

describe("resolveSpawnEnv", () => {
  it("returns undefined for a job that captured nothing (plain inheritance)", () => {
    expect(resolveSpawnEnv(undefined, { PATH: "/usr/bin" })).toBeUndefined();
    expect(resolveSpawnEnv(null, { PATH: "/usr/bin" })).toBeUndefined();
    expect(resolveSpawnEnv({}, { PATH: "/usr/bin" })).toBeUndefined();
  });

  it("layers captured vars over the base environment", () => {
    const base = { PATH: "/usr/bin", HOME: "/home/u" };
    const merged = resolveSpawnEnv({ ANTHROPIC_BASE_URL: "https://x.test" }, base);
    expect(merged).toEqual({ PATH: "/usr/bin", HOME: "/home/u", ANTHROPIC_BASE_URL: "https://x.test" });
  });

  it("overrides a base var the job also captured", () => {
    const merged = resolveSpawnEnv({ HTTPS_PROXY: "http://job" }, { HTTPS_PROXY: "http://daemon", PATH: "/bin" });
    expect(merged).toEqual({ HTTPS_PROXY: "http://job", PATH: "/bin" });
  });

  it("does not mutate the base environment", () => {
    const base = { PATH: "/bin" };
    resolveSpawnEnv({ X: "1" }, base);
    expect(base).toEqual({ PATH: "/bin" });
  });
});
