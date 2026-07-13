import { describe, expect, it } from "vitest";
import {
  type AgentRelayConfig,
  applyConfigToEnv,
  configFilePath,
  configToEnv,
  loadConfig,
  parseConfig,
  resolveEnvWithConfig,
} from "../src/config-file.js";

describe("configFilePath", () => {
  it("uses AGENTRELAY_CONFIG override when set", () => {
    expect(configFilePath({ AGENTRELAY_CONFIG: "/etc/ar.json" })).toBe("/etc/ar.json");
  });

  it("trims whitespace-only override to the default path", () => {
    const p = configFilePath({ AGENTRELAY_CONFIG: "   " });
    expect(p.endsWith("/.agentrelay/config.json")).toBe(true);
  });

  it("defaults to ~/.agentrelay/config.json", () => {
    expect(configFilePath({})).toMatch(/\.agentrelay\/config\.json$/);
  });
});

describe("parseConfig", () => {
  it("keeps recognized keys and collects unknown ones", () => {
    const { config, unknownKeys } = parseConfig(
      JSON.stringify({ store: "/tmp/j.json", maxAttempts: 7, bogus: 1, autoPrune: true })
    );
    expect(config).toEqual({ store: "/tmp/j.json", maxAttempts: 7, autoPrune: true });
    expect(unknownKeys).toEqual(["bogus"]);
  });

  it("drops null/undefined values without error", () => {
    const { config } = parseConfig(JSON.stringify({ store: null, maxAttempts: 3 }));
    expect(config).toEqual({ maxAttempts: 3 });
  });

  it("throws on malformed JSON", () => {
    expect(() => parseConfig("{ not json")).toThrow(/not valid JSON/);
  });

  it("throws when top level is not an object", () => {
    expect(() => parseConfig("[1,2,3]")).toThrow(/must contain a JSON object/);
    expect(() => parseConfig('"hi"')).toThrow(/must contain a JSON object/);
  });

  it("throws when a recognized value has a wrong type", () => {
    expect(() => parseConfig(JSON.stringify({ store: { nested: true } }))).toThrow(
      /must be a string, number, or boolean/
    );
  });
});

describe("configToEnv", () => {
  it("maps friendly keys to env vars and stringifies values", () => {
    const config: AgentRelayConfig = {
      store: "/tmp/j.json",
      maxAttempts: 5,
      autoPrune: true,
      autoPruneEvery: "1h",
    };
    expect(configToEnv(config)).toEqual({
      AGENTRELAY_STORE: "/tmp/j.json",
      AGENTRELAY_MAX_ATTEMPTS: "5",
      AGENTRELAY_AUTOPRUNE: "true",
      AGENTRELAY_AUTOPRUNE_EVERY: "1h",
    });
  });

  it("renders booleans as true/false strings", () => {
    expect(configToEnv({ autoPrune: false })).toEqual({ AGENTRELAY_AUTOPRUNE: "false" });
  });
});

describe("applyConfigToEnv", () => {
  it("fills only unset env vars — a real env var always wins", () => {
    const env = { AGENTRELAY_MAX_ATTEMPTS: "9", PATH: "/usr/bin" };
    const merged = applyConfigToEnv({ maxAttempts: 3, store: "/tmp/j.json" }, env);
    expect(merged.AGENTRELAY_MAX_ATTEMPTS).toBe("9"); // env wins
    expect(merged.AGENTRELAY_STORE).toBe("/tmp/j.json"); // config fills the gap
    expect(merged.PATH).toBe("/usr/bin"); // unrelated vars preserved
  });

  it("does not mutate the input env", () => {
    const env = { PATH: "/usr/bin" };
    applyConfigToEnv({ store: "/tmp/j.json" }, env);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});

describe("loadConfig", () => {
  it("returns null when the file does not exist", () => {
    const loaded = loadConfig({ AGENTRELAY_CONFIG: "/nope/config.json" }, () => null);
    expect(loaded).toBeNull();
  });

  it("returns parsed config, unknown keys, and the resolved path", () => {
    const loaded = loadConfig({ AGENTRELAY_CONFIG: "/cfg.json" }, () => JSON.stringify({ maxAttempts: 2, junk: true }));
    expect(loaded).toEqual({
      config: { maxAttempts: 2 },
      unknownKeys: ["junk"],
      path: "/cfg.json",
    });
  });
});

describe("resolveEnvWithConfig", () => {
  it("layers config under env and invokes onLoad", () => {
    let seenPath = "";
    const env = { AGENTRELAY_STORE: "/env.json" };
    const merged = resolveEnvWithConfig(env, {
      readFile: () => JSON.stringify({ store: "/file.json", maxAttempts: 4 }),
      onLoad: (l) => {
        seenPath = l.path;
      },
    });
    expect(merged.AGENTRELAY_STORE).toBe("/env.json"); // env wins
    expect(merged.AGENTRELAY_MAX_ATTEMPTS).toBe("4"); // from file
    expect(seenPath).toMatch(/config\.json$/);
  });

  it("returns the input env unchanged when no file exists", () => {
    const env = { A: "1" };
    expect(resolveEnvWithConfig(env, { readFile: () => null })).toBe(env);
  });
});
