import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentRelayConfig,
  applyConfigToEnv,
  CONFIG_ENV_KEYS,
  CONFIG_FIELDS,
  configFieldEnvKey,
  configToEnv,
  configToJson,
  findConfigField,
  getEffectiveConfigValue,
  hasConfigErrors,
  loadConfigFile,
  parseConfig,
  resolveConfigPath,
  resolveConfigWritePath,
  resolveEffectiveConfig,
  SETTABLE_CONFIG_KEYS,
  sampleConfig,
  sampleConfigJson,
  setConfigValue,
  unsetConfigValue,
  validateConfig,
} from "../src/config.js";

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

describe("sampleConfig", () => {
  it("round-trips through parseConfig without loss", () => {
    const sample = sampleConfig();
    // parseConfig should accept it verbatim (no unknown keys, correct types).
    expect(parseConfig(sample)).toEqual(sample);
  });

  it("populates every top-level group so the file self-documents", () => {
    const sample = sampleConfig();
    expect(sample.store).toBeDefined();
    expect(sample.notify).toBeDefined();
    expect(sample.retry).toBeDefined();
    expect(sample.autoPrune).toBeDefined();
    // A brand-new user should not accidentally enable destructive auto-prune.
    expect(sample.autoPrune?.enabled).toBe(false);
  });

  it("renders pretty JSON with a trailing newline that parses back", () => {
    const json = sampleConfigJson();
    expect(json.endsWith("\n")).toBe(true);
    expect(json).toContain("\n  "); // 2-space indented
    expect(JSON.parse(json)).toEqual(sampleConfig());
  });
});

describe("validateConfig", () => {
  it("reports no issues for the sample config", () => {
    expect(validateConfig(sampleConfig())).toEqual([]);
  });

  it("reports no issues for an empty config", () => {
    expect(validateConfig({})).toEqual([]);
  });

  it("flags negative or non-integer retry numbers as errors", () => {
    const issues = validateConfig({ retry: { maxAttempts: -1, baseDelayMs: 1.5, maxDelayMs: -5 } });
    const paths = issues.filter((i) => i.level === "error").map((i) => i.path);
    expect(paths).toContain("retry.maxAttempts");
    expect(paths).toContain("retry.baseDelayMs");
    expect(paths).toContain("retry.maxDelayMs");
  });

  it("flags a factor below 1 as an error", () => {
    const issues = validateConfig({ retry: { factor: 0.5 } });
    expect(issues).toEqual([expect.objectContaining({ level: "error", path: "retry.factor" })]);
  });

  it("accepts a factor of exactly 1", () => {
    expect(validateConfig({ retry: { factor: 1 } })).toEqual([]);
  });

  it("errors on a jitter fraction outside [0, 1]", () => {
    expect(validateConfig({ retry: { jitter: -0.1 } })).toEqual([
      expect.objectContaining({ level: "error", path: "retry.jitter" }),
    ]);
    expect(validateConfig({ retry: { jitter: 1.5 } })).toEqual([
      expect.objectContaining({ level: "error", path: "retry.jitter" }),
    ]);
  });

  it("accepts a jitter fraction at the [0, 1] bounds", () => {
    expect(validateConfig({ retry: { jitter: 0 } })).toEqual([]);
    expect(validateConfig({ retry: { jitter: 1 } })).toEqual([]);
    expect(validateConfig({ retry: { jitter: 0.3 } })).toEqual([]);
  });

  it("warns when the delay cap is below the base delay", () => {
    const issues = validateConfig({ retry: { baseDelayMs: 1000, maxDelayMs: 500 } });
    expect(issues).toEqual([expect.objectContaining({ level: "warning", path: "retry.maxDelayMs" })]);
  });

  it("errors on unparseable auto-prune durations", () => {
    const issues = validateConfig({ autoPrune: { after: "soon", every: "1 week" } });
    const paths = issues.filter((i) => i.level === "error").map((i) => i.path);
    expect(paths).toContain("autoPrune.after");
    expect(paths).toContain("autoPrune.every");
  });

  it("accepts valid auto-prune durations and zero thresholds", () => {
    expect(validateConfig({ autoPrune: { after: "0s", every: "30m", keep: 0, everyTicks: 0 } })).toEqual([]);
  });

  it("errors on a webhook URL that is not http(s)", () => {
    const issues = validateConfig({ notify: { webhookUrl: "ftp://example.com/hook" } });
    expect(issues).toEqual([expect.objectContaining({ level: "error", path: "notify.webhookUrl" })]);
  });

  it("warns (not errors) on a Slack webhook that is not a URL", () => {
    const issues = validateConfig({ notify: { slackWebhook: "not-a-url" } });
    expect(issues).toEqual([expect.objectContaining({ level: "warning", path: "notify.slackWebhook" })]);
    expect(hasConfigErrors(issues)).toBe(false);
  });

  it("warns on an empty store path", () => {
    const issues = validateConfig({ store: "   " });
    expect(issues).toEqual([expect.objectContaining({ level: "warning", path: "store" })]);
  });

  it("hasConfigErrors is true only when an error-level issue exists", () => {
    expect(hasConfigErrors([{ level: "warning", path: "x", message: "y" }])).toBe(false);
    expect(hasConfigErrors([{ level: "error", path: "x", message: "y" }])).toBe(true);
    expect(hasConfigErrors([])).toBe(false);
  });
});

describe("resolveEffectiveConfig", () => {
  const find = (entries: ReturnType<typeof resolveEffectiveConfig>, key: string) => {
    const entry = entries.find((e) => e.key === key);
    if (!entry) throw new Error(`no entry for ${key}`);
    return entry;
  };

  it("marks everything as a default when no file and empty env", () => {
    const entries = resolveEffectiveConfig(null, {});
    expect(entries).toHaveLength(CONFIG_ENV_KEYS.length);
    expect(entries.every((e) => e.source === "default" && e.value === undefined)).toBe(true);
  });

  it("attributes a value to the config file when env does not set it", () => {
    const entries = resolveEffectiveConfig({ store: "/tmp/jobs.json" }, {});
    const store = find(entries, "AGENTRELAY_STORE");
    expect(store).toMatchObject({ source: "config-file", value: "/tmp/jobs.json" });
  });

  it("lets an env var win over the config file (precedence)", () => {
    const entries = resolveEffectiveConfig({ store: "/from/file.json" }, { AGENTRELAY_STORE: "/from/env.json" });
    expect(find(entries, "AGENTRELAY_STORE")).toMatchObject({ source: "env", value: "/from/env.json" });
  });

  it("projects the boolean autoPrune flag as the file's 1/0 env form", () => {
    const entries = resolveEffectiveConfig({ autoPrune: { enabled: true } }, {});
    expect(find(entries, "AGENTRELAY_AUTOPRUNE")).toMatchObject({ source: "config-file", value: "1" });
  });

  it("flags secret keys so the CLI can mask them", () => {
    const entries = resolveEffectiveConfig(null, {});
    expect(find(entries, "AGENTRELAY_WEBHOOK_AUTH").secret).toBe(true);
    expect(find(entries, "AGENTRELAY_STORE").secret).toBe(false);
  });

  it("stays in sync with configToEnv — every emittable key is known", () => {
    // sampleConfig populates every group, so configToEnv exercises all keys.
    const emitted = Object.keys(configToEnv(sampleConfig()));
    const known = new Set(CONFIG_ENV_KEYS.map((k) => k.key));
    for (const key of emitted) expect(known.has(key)).toBe(true);
    // ...and no known key is dead (each maps to something configToEnv can emit).
    for (const { key } of CONFIG_ENV_KEYS) expect(emitted).toContain(key);
  });
});

describe("configFieldEnvKey", () => {
  it("maps every settable dotted key to exactly one known env var", () => {
    const known = new Set(CONFIG_ENV_KEYS.map((k) => k.key));
    for (const key of SETTABLE_CONFIG_KEYS) {
      const envKey = configFieldEnvKey(key);
      expect(envKey).toBeDefined();
      expect(known.has(envKey as string)).toBe(true);
    }
  });

  it("maps representative keys to their expected env vars", () => {
    expect(configFieldEnvKey("store")).toBe("AGENTRELAY_STORE");
    expect(configFieldEnvKey("retry.maxAttempts")).toBe("AGENTRELAY_MAX_ATTEMPTS");
    // The boolean flag projects onto the 1/0 env var, not a literal name match.
    expect(configFieldEnvKey("autoPrune.enabled")).toBe("AGENTRELAY_AUTOPRUNE");
    expect(configFieldEnvKey("notify.webhookAuth")).toBe("AGENTRELAY_WEBHOOK_AUTH");
  });

  it("returns undefined for an unknown key", () => {
    expect(configFieldEnvKey("nope")).toBeUndefined();
    expect(configFieldEnvKey("retry.nope")).toBeUndefined();
    expect(configFieldEnvKey("")).toBeUndefined();
  });
});

describe("getEffectiveConfigValue", () => {
  it("returns the config-file value and source when env does not set it", () => {
    const entry = getEffectiveConfigValue("retry.maxAttempts", { retry: { maxAttempts: 7 } }, {});
    expect(entry).toMatchObject({ key: "AGENTRELAY_MAX_ATTEMPTS", value: "7", source: "config-file" });
  });

  it("lets an env var win over the config file (precedence)", () => {
    const entry = getEffectiveConfigValue(
      "store",
      { store: "/from/file.json" },
      { AGENTRELAY_STORE: "/from/env.json" }
    );
    expect(entry).toMatchObject({ value: "/from/env.json", source: "env" });
  });

  it("reports source=default and value=undefined when nothing sets the key", () => {
    const entry = getEffectiveConfigValue("retry.factor", null, {});
    expect(entry).toMatchObject({ source: "default", value: undefined });
  });

  it("carries the secret flag for masking", () => {
    const entry = getEffectiveConfigValue("notify.webhookAuth", { notify: { webhookAuth: "tok" } }, {});
    expect(entry).toMatchObject({ value: "tok", secret: true });
  });

  it("projects the boolean autoPrune flag as its 1/0 env value", () => {
    const entry = getEffectiveConfigValue("autoPrune.enabled", { autoPrune: { enabled: true } }, {});
    expect(entry).toMatchObject({ key: "AGENTRELAY_AUTOPRUNE", value: "1", source: "config-file" });
  });

  it("returns undefined for an unknown key so the CLI can distinguish it from a default", () => {
    expect(getEffectiveConfigValue("bogus.key", null, {})).toBeUndefined();
  });
});

describe("CONFIG_FIELDS / setConfigValue / unsetConfigValue", () => {
  it("has one settable field per env-backed key (no drift)", () => {
    // `config set` must reach precisely the values `config show` reports.
    expect(CONFIG_FIELDS).toHaveLength(CONFIG_ENV_KEYS.length);
    // Each field, when set, projects onto exactly one AGENTRELAY_* env var.
    const sample = (f: (typeof CONFIG_FIELDS)[number]): string =>
      f.type === "boolean" ? "true" : f.type === "number" ? "1" : f.type === "duration" ? "1h" : "x";
    const known = new Set(CONFIG_ENV_KEYS.map((k) => k.key));
    for (const field of CONFIG_FIELDS) {
      const keys = Object.keys(configToEnv(setConfigValue({}, field.key, sample(field))));
      expect(keys).toHaveLength(1);
      expect(known.has(keys[0])).toBe(true);
    }
  });

  it("SETTABLE_CONFIG_KEYS matches CONFIG_FIELDS", () => {
    expect(SETTABLE_CONFIG_KEYS).toEqual(CONFIG_FIELDS.map((f) => f.key));
  });

  it("sets a top-level string field", () => {
    expect(setConfigValue({}, "store", "/tmp/x.json")).toEqual({ store: "/tmp/x.json" });
  });

  it("sets a nested field, creating the group", () => {
    expect(setConfigValue({}, "retry.maxAttempts", "7")).toEqual({ retry: { maxAttempts: 7 } });
  });

  it("coerces booleans from several truthy/falsy spellings", () => {
    for (const t of ["true", "1", "yes", "on", "ON"]) {
      expect(setConfigValue({}, "autoPrune.enabled", t)).toEqual({ autoPrune: { enabled: true } });
    }
    for (const f of ["false", "0", "no", "off"]) {
      expect(setConfigValue({}, "autoPrune.enabled", f)).toEqual({ autoPrune: { enabled: false } });
    }
  });

  it("rejects a non-boolean for a boolean field", () => {
    expect(() => setConfigValue({}, "autoPrune.enabled", "maybe")).toThrow(/boolean/);
  });

  it("rejects a non-number for a number field", () => {
    expect(() => setConfigValue({}, "retry.factor", "abc")).toThrow(/finite number/);
    expect(() => setConfigValue({}, "retry.maxAttempts", "")).toThrow(/finite number/);
  });

  it("validates duration fields at set time", () => {
    expect(setConfigValue({}, "autoPrune.after", "14d")).toEqual({ autoPrune: { after: "14d" } });
    expect(() => setConfigValue({}, "autoPrune.after", "banana")).toThrow(/duration/);
  });

  it("rejects an unknown key with the list of valid keys", () => {
    expect(() => setConfigValue({}, "retry.nope", "1")).toThrow(/Unknown config key/);
  });

  it("does not mutate the input config", () => {
    const original: AgentRelayConfig = { retry: { maxAttempts: 3 } };
    const next = setConfigValue(original, "retry.factor", "4");
    expect(original).toEqual({ retry: { maxAttempts: 3 } });
    expect(next).toEqual({ retry: { maxAttempts: 3, factor: 4 } });
  });

  it("preserves sibling fields when setting a nested value", () => {
    const cfg: AgentRelayConfig = { notify: { slackWebhook: "https://a" } };
    expect(setConfigValue(cfg, "notify.webhookUrl", "https://b")).toEqual({
      notify: { slackWebhook: "https://a", webhookUrl: "https://b" },
    });
  });

  it("unsets a nested field and drops the emptied group", () => {
    const cfg: AgentRelayConfig = { retry: { maxAttempts: 3 } };
    expect(unsetConfigValue(cfg, "retry.maxAttempts")).toEqual({});
  });

  it("unsets a nested field but keeps a non-empty group", () => {
    const cfg: AgentRelayConfig = { retry: { maxAttempts: 3, factor: 2 } };
    expect(unsetConfigValue(cfg, "retry.factor")).toEqual({ retry: { maxAttempts: 3 } });
  });

  it("unsetting a missing key is a no-op (not an error)", () => {
    expect(unsetConfigValue({}, "store")).toEqual({});
  });

  it("unset rejects an unknown key", () => {
    expect(() => unsetConfigValue({}, "retry.nope")).toThrow(/Unknown config key/);
  });

  it("round-trips a set result through parseConfig and configToJson", () => {
    const cfg = setConfigValue(setConfigValue({}, "retry.maxAttempts", "9"), "autoPrune.enabled", "true");
    const json = configToJson(cfg);
    expect(json.endsWith("\n")).toBe(true);
    expect(parseConfig(JSON.parse(json))).toEqual(cfg);
  });

  it("findConfigField finds known fields and flags secrets", () => {
    expect(findConfigField("notify.webhookAuth")?.secret).toBe(true);
    expect(findConfigField("store")?.secret).toBeUndefined();
    expect(findConfigField("nope")).toBeUndefined();
  });
});

describe("resolveConfigWritePath", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-cfgwrite-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("honors an explicit path", () => {
    expect(resolveConfigWritePath({ path: "/x/custom.json", cwd: dir, env: {} })).toBe("/x/custom.json");
  });

  it("honors AGENTRELAY_CONFIG when no explicit path", () => {
    expect(resolveConfigWritePath({ cwd: dir, env: { AGENTRELAY_CONFIG: "/x/env.json" } })).toBe("/x/env.json");
  });

  it("returns an existing discovered project-local file", () => {
    const local = join(dir, "agentrelay.config.json");
    writeFileSync(local, "{}\n", "utf8");
    expect(resolveConfigWritePath({ cwd: dir, env: {} })).toBe(local);
  });

  it("defaults to <cwd>/agentrelay.config.json when nothing exists", () => {
    expect(resolveConfigWritePath({ cwd: dir, env: { HOME: dir } })).toBe(join(dir, "agentrelay.config.json"));
  });
});
