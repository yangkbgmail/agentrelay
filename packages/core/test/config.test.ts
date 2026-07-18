import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentRelayConfig,
  applyConfigToEnv,
  buildSampleConfig,
  configToEnv,
  loadConfigFile,
  parseConfig,
  resolveConfigPath,
  serializeConfig,
} from "../src/config.js";
import { DEFAULT_RETRY_POLICY } from "../src/retry.js";

describe("configToEnv", () => {
  it("returns an empty map for an empty config", () => {
    expect(configToEnv({})).toEqual({});
  });

  it("maps every field onto its AGENTRELAY_* env var", () => {
    const config: AgentRelayConfig = {
      store: "/tmp/jobs.json",
      notify: { slackWebhook: "https://slack", webhookUrl: "https://hook", webhookAuth: "Bearer x" },
      retry: { maxAttempts: 3, baseDelayMs: 1000, factor: 3, maxDelayMs: 9000 },
      autoPrune: { enabled: true, after: "3d", keep: 20, every: "1h", everyTicks: 50 },
    };
    expect(configToEnv(config)).toEqual({
      AGENTRELAY_STORE: "/tmp/jobs.json",
      AGENTRELAY_SLACK_WEBHOOK: "https://slack",
      AGENTRELAY_WEBHOOK_URL: "https://hook",
      AGENTRELAY_WEBHOOK_AUTH: "Bearer x",
      AGENTRELAY_MAX_ATTEMPTS: "3",
      AGENTRELAY_RETRY_BASE_MS: "1000",
      AGENTRELAY_RETRY_FACTOR: "3",
      AGENTRELAY_RETRY_MAX_MS: "9000",
      AGENTRELAY_AUTOPRUNE: "1",
      AGENTRELAY_AUTOPRUNE_AFTER: "3d",
      AGENTRELAY_AUTOPRUNE_KEEP: "20",
      AGENTRELAY_AUTOPRUNE_EVERY: "1h",
      AGENTRELAY_AUTOPRUNE_EVERY_TICKS: "50",
    });
  });

  it("encodes autoPrune.enabled:false as '0' so it is representable, and skips unset keys", () => {
    expect(configToEnv({ autoPrune: { enabled: false } })).toEqual({ AGENTRELAY_AUTOPRUNE: "0" });
    // maxAttempts 0 (unlimited) must still be emitted, not dropped as falsy.
    expect(configToEnv({ retry: { maxAttempts: 0 } })).toEqual({ AGENTRELAY_MAX_ATTEMPTS: "0" });
  });
});

describe("applyConfigToEnv", () => {
  it("fills in unset keys but never overwrites an explicit env value", () => {
    const env: Record<string, string | undefined> = { AGENTRELAY_STORE: "/explicit/jobs.json" };
    const applied = applyConfigToEnv({ store: "/config/jobs.json", retry: { maxAttempts: 7 } }, env);
    // store was already set -> untouched; maxAttempts was missing -> filled.
    expect(env.AGENTRELAY_STORE).toBe("/explicit/jobs.json");
    expect(env.AGENTRELAY_MAX_ATTEMPTS).toBe("7");
    expect(applied).toEqual(["AGENTRELAY_MAX_ATTEMPTS"]);
  });
});

describe("parseConfig", () => {
  it("ignores unknown top-level keys for forward compatibility", () => {
    expect(parseConfig({ store: "/x", somethingNew: 42 })).toEqual({ store: "/x" });
  });

  it("throws on a non-object root", () => {
    expect(() => parseConfig([], "cfg")).toThrow(/cfg must be an object/);
    expect(() => parseConfig("nope", "cfg")).toThrow(/must be an object/);
  });

  it("throws with a path-qualified message on a wrong field type", () => {
    expect(() => parseConfig({ retry: { maxAttempts: "five" } }, "cfg")).toThrow(
      /cfg\.retry\.maxAttempts must be a finite number/
    );
    expect(() => parseConfig({ store: 123 }, "cfg")).toThrow(/cfg\.store must be a string/);
    expect(() => parseConfig({ autoPrune: { enabled: "yes" } }, "cfg")).toThrow(
      /cfg\.autoPrune\.enabled must be a boolean/
    );
  });

  it("rejects NaN/Infinity numbers", () => {
    expect(() => parseConfig({ retry: { factor: Number.POSITIVE_INFINITY } })).toThrow(/finite number/);
  });
});

describe("resolveConfigPath / loadConfigFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no config is present anywhere", () => {
    // Point cwd + HOME at an empty dir so discovery finds nothing.
    expect(resolveConfigPath({ cwd: dir, env: { HOME: dir } })).toBeNull();
    expect(loadConfigFile({ cwd: dir, env: { HOME: dir } })).toBeNull();
  });

  it("discovers ./agentrelay.config.json in the working directory", () => {
    const path = join(dir, "agentrelay.config.json");
    writeFileSync(path, JSON.stringify({ store: "/from/file.json" }));
    expect(resolveConfigPath({ cwd: dir, env: { HOME: dir } })).toBe(path);
    const loaded = loadConfigFile({ cwd: dir, env: { HOME: dir } });
    expect(loaded?.path).toBe(path);
    expect(loaded?.config.store).toBe("/from/file.json");
  });

  it("prefers an explicit path (and the AGENTRELAY_CONFIG env) over discovery", () => {
    const explicit = join(dir, "custom.json");
    writeFileSync(explicit, JSON.stringify({ retry: { maxAttempts: 9 } }));
    expect(resolveConfigPath({ path: explicit, cwd: dir })).toBe(explicit);
    expect(resolveConfigPath({ env: { AGENTRELAY_CONFIG: explicit }, cwd: dir })).toBe(explicit);
    expect(loadConfigFile({ path: explicit })?.config.retry?.maxAttempts).toBe(9);
  });

  it("throws when an explicitly named config file is missing", () => {
    expect(() => loadConfigFile({ path: join(dir, "nope.json") })).toThrow(/not found/);
  });

  it("throws on invalid JSON", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ not json");
    expect(() => loadConfigFile({ path })).toThrow(/Invalid JSON/);
  });
});

describe("buildSampleConfig / serializeConfig", () => {
  it("populates every option group at its built-in default", () => {
    const sample = buildSampleConfig("/tmp/jobs.json");
    expect(sample.store).toBe("/tmp/jobs.json");
    expect(sample.retry).toEqual({
      maxAttempts: DEFAULT_RETRY_POLICY.maxAttempts,
      baseDelayMs: DEFAULT_RETRY_POLICY.baseDelayMs,
      factor: DEFAULT_RETRY_POLICY.factor,
      maxDelayMs: DEFAULT_RETRY_POLICY.maxDelayMs,
    });
    // Ships inert: auto-prune off and blank notification secrets so a fresh
    // config changes no behavior until the user edits it.
    expect(sample.autoPrune?.enabled).toBe(false);
    expect(sample.notify).toEqual({ slackWebhook: "", webhookUrl: "", webhookAuth: "" });
  });

  it("omits store when no path is provided", () => {
    expect(buildSampleConfig().store).toBeUndefined();
  });

  it("round-trips through parseConfig unchanged", () => {
    const sample = buildSampleConfig("/tmp/jobs.json");
    const json = serializeConfig(sample);
    expect(json.endsWith("\n")).toBe(true);
    expect(parseConfig(JSON.parse(json))).toEqual(sample);
  });

  it("serializes to pretty-printed JSON", () => {
    expect(serializeConfig({ retry: { maxAttempts: 3 } })).toBe(`{\n  "retry": {\n    "maxAttempts": 3\n  }\n}\n`);
  });
});
