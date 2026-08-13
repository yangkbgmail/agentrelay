import { describe, expect, it } from "vitest";
import { CONFIG_ENV_KEYS } from "./config.js";
import { configBackedEnvDrift, describeEnv, ENV_VARS } from "./env.js";

describe("ENV_VARS registry", () => {
  it("has unique keys, all AGENTRELAY_-prefixed", () => {
    const keys = ENV_VARS.map((v) => v.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toMatch(/^AGENTRELAY_[A-Z_]+$/);
    }
  });

  it("gives every entry a non-empty description", () => {
    for (const v of ENV_VARS) {
      expect(v.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("stays in sync with the config-backed env keys (no drift)", () => {
    const drift = configBackedEnvDrift();
    expect(drift).toEqual({ missingHere: [], extraHere: [] });
  });

  it("covers every config-backed env key with configBacked: true", () => {
    const backedHere = new Set(ENV_VARS.filter((v) => v.configBacked).map((v) => v.key));
    for (const { key } of CONFIG_ENV_KEYS) {
      expect(backedHere.has(key)).toBe(true);
    }
  });

  it("documents the purely-env vars that config show cannot reach", () => {
    const pureEnv = ENV_VARS.filter((v) => !v.configBacked).map((v) => v.key);
    expect(pureEnv).toContain("AGENTRELAY_CONFIG");
    expect(pureEnv).toContain("AGENTRELAY_MAX_CONCURRENT");
    // Those keys must NOT be in the config-backed registry.
    const backed = new Set(CONFIG_ENV_KEYS.map((k) => k.key));
    expect(backed.has("AGENTRELAY_CONFIG")).toBe(false);
    expect(backed.has("AGENTRELAY_MAX_CONCURRENT")).toBe(false);
  });

  it("marks the webhook/token vars secret and nothing else", () => {
    const secret = ENV_VARS.filter((v) => v.secret)
      .map((v) => v.key)
      .sort();
    expect(secret).toEqual(["AGENTRELAY_SLACK_WEBHOOK", "AGENTRELAY_WEBHOOK_AUTH", "AGENTRELAY_WEBHOOK_URL"]);
  });
});

describe("describeEnv", () => {
  it("reports every var as unset against an empty environment", () => {
    const states = describeEnv({});
    expect(states).toHaveLength(ENV_VARS.length);
    for (const s of states) {
      expect(s.set).toBe(false);
      expect(s.value).toBeUndefined();
    }
  });

  it("reads a set value verbatim", () => {
    const states = describeEnv({ AGENTRELAY_MAX_CONCURRENT: "4" });
    const conc = states.find((s) => s.key === "AGENTRELAY_MAX_CONCURRENT");
    expect(conc?.set).toBe(true);
    expect(conc?.value).toBe("4");
  });

  it("treats a blank / whitespace-only value as not set", () => {
    const states = describeEnv({ AGENTRELAY_STORE: "   ", AGENTRELAY_MAX_ATTEMPTS: "" });
    const store = states.find((s) => s.key === "AGENTRELAY_STORE");
    const attempts = states.find((s) => s.key === "AGENTRELAY_MAX_ATTEMPTS");
    expect(store?.set).toBe(false);
    expect(store?.value).toBeUndefined();
    expect(attempts?.set).toBe(false);
  });

  it("preserves the registry's declared order", () => {
    const states = describeEnv({});
    expect(states.map((s) => s.key)).toEqual(ENV_VARS.map((v) => v.key));
  });

  it("carries through doc metadata (description, secret, defaultHint)", () => {
    const states = describeEnv({ AGENTRELAY_SLACK_WEBHOOK: "https://hooks.example/abc" });
    const slack = states.find((s) => s.key === "AGENTRELAY_SLACK_WEBHOOK");
    expect(slack?.secret).toBe(true);
    expect(slack?.description).toMatch(/Slack/);
    expect(slack?.value).toBe("https://hooks.example/abc");
  });
});
