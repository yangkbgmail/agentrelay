import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDuration } from "./prune.js";

/**
 * Persistent configuration for AgentRelay, read from a JSON file so users don't
 * have to re-export the same `AGENTRELAY_*` environment variables in every
 * shell. Every field is optional and maps 1:1 onto an existing env-driven
 * option (see {@link configToEnv}); the file is purely a convenience layer.
 *
 * Precedence is always: explicit environment variable > config file > built-in
 * default. That is enforced by only ever *filling in* env vars that aren't
 * already set (see {@link applyConfigToEnv}), so a one-off `AGENTRELAY_STORE=…`
 * on the command line still wins over the file.
 */
export interface AgentRelayConfig {
  /** Job store path — maps to `AGENTRELAY_STORE`. */
  store?: string;
  /** Notification channels. */
  notify?: {
    /** Slack incoming-webhook URL — maps to `AGENTRELAY_SLACK_WEBHOOK`. */
    slackWebhook?: string;
    /** Generic webhook endpoint — maps to `AGENTRELAY_WEBHOOK_URL`. */
    webhookUrl?: string;
    /** Value sent as the webhook `Authorization` header — maps to `AGENTRELAY_WEBHOOK_AUTH`. */
    webhookAuth?: string;
  };
  /** Retry / exponential-backoff policy. */
  retry?: {
    /** `AGENTRELAY_MAX_ATTEMPTS` (0 = unlimited). */
    maxAttempts?: number;
    /** `AGENTRELAY_RETRY_BASE_MS`. */
    baseDelayMs?: number;
    /** `AGENTRELAY_RETRY_FACTOR`. */
    factor?: number;
    /** `AGENTRELAY_RETRY_MAX_MS`. */
    maxDelayMs?: number;
  };
  /** Daemon auto-prune settings. */
  autoPrune?: {
    /** Opt-in flag — maps to `AGENTRELAY_AUTOPRUNE`. */
    enabled?: boolean;
    /** Age threshold duration like `7d`/`24h` — maps to `AGENTRELAY_AUTOPRUNE_AFTER`. */
    after?: string;
    /** Always keep the N most-recent finished jobs — maps to `AGENTRELAY_AUTOPRUNE_KEEP`. */
    keep?: number;
    /** Minimum wall-clock interval between passes — maps to `AGENTRELAY_AUTOPRUNE_EVERY`. */
    every?: string;
    /** Minimum ticks between passes — maps to `AGENTRELAY_AUTOPRUNE_EVERY_TICKS`. */
    everyTicks?: number;
  };
}

/** Filename looked for in the current directory during config discovery. */
export const CONFIG_FILENAME = "agentrelay.config.json";

/**
 * A fully-populated example config with the built-in defaults spelled out.
 * Since JSON can't carry comments, every field being present *is* the
 * documentation — users edit or delete the lines they don't need. The values
 * mirror the framework defaults (see the `*FromEnv` helpers), so writing this
 * file and running with it changes nothing until the user tweaks something.
 *
 * Round-trips cleanly through {@link parseConfig}.
 */
export function sampleConfig(): AgentRelayConfig {
  return {
    store: "~/.agentrelay/jobs.json",
    notify: {
      slackWebhook: "",
      webhookUrl: "",
      webhookAuth: "",
    },
    retry: {
      maxAttempts: 5,
      baseDelayMs: 1000,
      factor: 2,
      maxDelayMs: 300000,
    },
    autoPrune: {
      enabled: false,
      after: "7d",
      keep: 50,
      every: "1h",
      everyTicks: 20,
    },
  };
}

/**
 * The {@link sampleConfig} rendered as a pretty-printed JSON string with a
 * trailing newline — ready to write to `agentrelay.config.json`. Exported so
 * both the CLI `config init` command and tooling can emit the same content.
 */
export function sampleConfigJson(): string {
  return `${JSON.stringify(sampleConfig(), null, 2)}\n`;
}

/**
 * The value type of a settable config field, used to coerce the raw string a
 * user types on the command line (`agentrelay config set <key> <value>`) into
 * the JSON type the config schema expects.
 *
 * - `string` — stored verbatim.
 * - `number` — parsed with {@link Number}; must be finite.
 * - `boolean` — accepts true/false, 1/0, yes/no, on/off (case-insensitive).
 * - `duration` — stored as the raw string but must parse via {@link parseDuration}
 *   (e.g. `7d`, `24h`, `30m`), so a typo is rejected at set time rather than
 *   silently ignored later.
 */
export type ConfigFieldType = "string" | "number" | "boolean" | "duration";

/** One dotted config key that {@link setConfigValue}/{@link unsetConfigValue} understand. */
export interface ConfigField {
  /** Dotted path used on the CLI, e.g. `retry.maxAttempts`. */
  key: string;
  /** The single `AGENTRELAY_*` env var this field projects onto (see {@link configToEnv}). */
  envKey: string;
  group: ConfigGroup;
  type: ConfigFieldType;
  /** Webhook URLs/auth tokens — masked when echoed back. */
  secret?: boolean;
}

/**
 * Every settable config field, keyed by its dotted CLI path. Mirrors the
 * {@link AgentRelayConfig} schema and {@link CONFIG_ENV_KEYS} exactly (a test
 * asserts they stay in sync), so `config set` can reach precisely the values
 * `config show` reports and no more.
 */
export const CONFIG_FIELDS: ConfigField[] = [
  { key: "store", envKey: "AGENTRELAY_STORE", group: "store", type: "string" },
  { key: "notify.slackWebhook", envKey: "AGENTRELAY_SLACK_WEBHOOK", group: "notify", type: "string", secret: true },
  { key: "notify.webhookUrl", envKey: "AGENTRELAY_WEBHOOK_URL", group: "notify", type: "string", secret: true },
  { key: "notify.webhookAuth", envKey: "AGENTRELAY_WEBHOOK_AUTH", group: "notify", type: "string", secret: true },
  { key: "retry.maxAttempts", envKey: "AGENTRELAY_MAX_ATTEMPTS", group: "retry", type: "number" },
  { key: "retry.baseDelayMs", envKey: "AGENTRELAY_RETRY_BASE_MS", group: "retry", type: "number" },
  { key: "retry.factor", envKey: "AGENTRELAY_RETRY_FACTOR", group: "retry", type: "number" },
  { key: "retry.maxDelayMs", envKey: "AGENTRELAY_RETRY_MAX_MS", group: "retry", type: "number" },
  { key: "autoPrune.enabled", envKey: "AGENTRELAY_AUTOPRUNE", group: "autoPrune", type: "boolean" },
  { key: "autoPrune.after", envKey: "AGENTRELAY_AUTOPRUNE_AFTER", group: "autoPrune", type: "duration" },
  { key: "autoPrune.keep", envKey: "AGENTRELAY_AUTOPRUNE_KEEP", group: "autoPrune", type: "number" },
  { key: "autoPrune.every", envKey: "AGENTRELAY_AUTOPRUNE_EVERY", group: "autoPrune", type: "duration" },
  { key: "autoPrune.everyTicks", envKey: "AGENTRELAY_AUTOPRUNE_EVERY_TICKS", group: "autoPrune", type: "number" },
];

/** Dotted keys of all settable config fields, in display order. */
export const SETTABLE_CONFIG_KEYS: string[] = CONFIG_FIELDS.map((f) => f.key);

/** Looks up a settable field by its dotted key, or `undefined` when unknown. */
export function findConfigField(key: string): ConfigField | undefined {
  return CONFIG_FIELDS.find((f) => f.key === key);
}

/**
 * Coerces the raw CLI string for `field` into its typed JSON value, throwing a
 * clear error when the input doesn't fit the field's type. Pure.
 */
export function coerceConfigValue(field: ConfigField, raw: string): string | number | boolean {
  switch (field.type) {
    case "string":
      return raw;
    case "number": {
      const trimmed = raw.trim();
      const n = trimmed === "" ? Number.NaN : Number(trimmed);
      if (!Number.isFinite(n)) {
        throw new Error(`${field.key} must be a finite number, got "${raw}"`);
      }
      return n;
    }
    case "boolean": {
      const v = raw.trim().toLowerCase();
      if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
      if (v === "false" || v === "0" || v === "no" || v === "off") return false;
      throw new Error(`${field.key} must be a boolean (true/false, 1/0, yes/no, on/off), got "${raw}"`);
    }
    case "duration": {
      const trimmed = raw.trim();
      if (parseDuration(trimmed) === null) {
        throw new Error(`${field.key} must be a duration like "7d", "24h", "30m", "90s" or "500ms", got "${raw}"`);
      }
      return trimmed;
    }
  }
}

/** Shallow-clones a config, copying each present group object so edits don't mutate the input. */
function cloneConfig(config: AgentRelayConfig): AgentRelayConfig {
  const clone: AgentRelayConfig = {};
  if (config.store !== undefined) clone.store = config.store;
  if (config.notify) clone.notify = { ...config.notify };
  if (config.retry) clone.retry = { ...config.retry };
  if (config.autoPrune) clone.autoPrune = { ...config.autoPrune };
  return clone;
}

/**
 * Returns a new config with `key` set to the coerced `raw` value. Throws on an
 * unknown key or a value that doesn't fit the field's type. Never mutates the
 * input. Pure — no filesystem — so the CLI `config set` command and tests share
 * exactly this logic.
 */
export function setConfigValue(config: AgentRelayConfig, key: string, raw: string): AgentRelayConfig {
  const field = findConfigField(key);
  if (!field) {
    throw new Error(`Unknown config key "${key}". Valid keys: ${SETTABLE_CONFIG_KEYS.join(", ")}.`);
  }
  const value = coerceConfigValue(field, raw);
  const next = cloneConfig(config) as Record<string, unknown>;
  const parts = key.split(".");
  if (parts.length === 1) {
    next[parts[0]] = value;
  } else {
    const [group, leaf] = parts;
    const groupObj = { ...((next[group] as Record<string, unknown> | undefined) ?? {}) };
    groupObj[leaf] = value;
    next[group] = groupObj;
  }
  return next as AgentRelayConfig;
}

/**
 * Returns a new config with `key` removed (falling back to the built-in default
 * at runtime). Emptied group objects are dropped so the file doesn't accumulate
 * `"retry": {}`. Throws on an unknown key. Never mutates the input. Pure.
 */
export function unsetConfigValue(config: AgentRelayConfig, key: string): AgentRelayConfig {
  const field = findConfigField(key);
  if (!field) {
    throw new Error(`Unknown config key "${key}". Valid keys: ${SETTABLE_CONFIG_KEYS.join(", ")}.`);
  }
  const next = cloneConfig(config) as Record<string, unknown>;
  const parts = key.split(".");
  if (parts.length === 1) {
    delete next[parts[0]];
  } else {
    const [group, leaf] = parts;
    const groupObj = next[group] as Record<string, unknown> | undefined;
    if (groupObj) {
      delete groupObj[leaf];
      if (Object.keys(groupObj).length === 0) delete next[group];
    }
  }
  return next as AgentRelayConfig;
}

/**
 * Serializes a config to the same pretty-printed JSON (2-space indent, trailing
 * newline) that `config init` writes, so a hand-written file and a
 * `config set`-edited one stay formatted identically. Round-trips through
 * {@link parseConfig}.
 */
export function configToJson(config: AgentRelayConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export interface LoadConfigOptions {
  /** Explicit file path (skips discovery). Falls back to `AGENTRELAY_CONFIG`. */
  path?: string;
  /** Environment used for the `AGENTRELAY_CONFIG` override. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Directory searched for `agentrelay.config.json`. Defaults to `process.cwd()`. */
  cwd?: string;
}

export interface LoadedConfig {
  config: AgentRelayConfig;
  /** The file the config was read from — handy for logging. */
  path: string;
}

/**
 * Resolves which config file to use, or `null` when none is found:
 *
 * 1. an explicit `path` argument, or `AGENTRELAY_CONFIG` env var (used even if
 *    the file is missing, so a bad override surfaces as a clear error);
 * 2. `<cwd>/agentrelay.config.json` (project-local);
 * 3. `~/.agentrelay/config.json` (per-user).
 */
export function resolveConfigPath(options: LoadConfigOptions = {}): string | null {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const explicit = options.path?.trim() || env.AGENTRELAY_CONFIG?.trim();
  if (explicit) return explicit;
  // Honor an env-provided HOME/USERPROFILE so the per-user candidate is
  // deterministic (and testable); fall back to the real home directory.
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const candidates = [join(cwd, CONFIG_FILENAME), join(home, ".agentrelay", "config.json")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolves a *definite* target path for writing a config file (used by
 * `config set`/`unset`, which must always have somewhere to write, unlike the
 * read-side {@link resolveConfigPath} that returns `null` when nothing exists):
 *
 * 1. an explicit `path` argument or `AGENTRELAY_CONFIG` env var;
 * 2. an already-existing discovered file (project-local or per-user);
 * 3. otherwise `<cwd>/agentrelay.config.json` — so a first `set` creates the
 *    project-local file rather than silently editing the per-user one.
 */
export function resolveConfigWritePath(options: LoadConfigOptions = {}): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const explicit = options.path?.trim() || env.AGENTRELAY_CONFIG?.trim();
  if (explicit) return explicit;
  const discovered = resolveConfigPath({ cwd, env });
  if (discovered) return discovered;
  return join(cwd, CONFIG_FILENAME);
}

/**
 * Loads and validates the config file, or returns `null` when no file is
 * present (discovery found nothing and none was requested explicitly). Throws a
 * clear error if a file *is* named but missing, unreadable, not valid JSON, or
 * structurally wrong — a broken config should never be silently ignored.
 */
export function loadConfigFile(options: LoadConfigOptions = {}): LoadedConfig | null {
  const path = resolveConfigPath(options);
  if (!path) return null;
  if (!existsSync(path)) {
    throw new Error(`AgentRelay config file not found: ${path}`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read AgentRelay config ${path}: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in AgentRelay config ${path}: ${String(error)}`);
  }
  return { config: parseConfig(parsed, path), path };
}

/**
 * Validates an already-parsed JSON value into an {@link AgentRelayConfig},
 * throwing on structural mistakes (wrong types) while ignoring unknown keys for
 * forward compatibility. Exported so tooling/tests can validate config objects
 * without touching the filesystem.
 */
export function parseConfig(value: unknown, source = "config"): AgentRelayConfig {
  const root = asObject(value, source);
  const config: AgentRelayConfig = {};

  if (root.store !== undefined) config.store = asString(root.store, `${source}.store`);

  if (root.notify !== undefined) {
    const notify = asObject(root.notify, `${source}.notify`);
    config.notify = {};
    if (notify.slackWebhook !== undefined)
      config.notify.slackWebhook = asString(notify.slackWebhook, `${source}.notify.slackWebhook`);
    if (notify.webhookUrl !== undefined)
      config.notify.webhookUrl = asString(notify.webhookUrl, `${source}.notify.webhookUrl`);
    if (notify.webhookAuth !== undefined)
      config.notify.webhookAuth = asString(notify.webhookAuth, `${source}.notify.webhookAuth`);
  }

  if (root.retry !== undefined) {
    const retry = asObject(root.retry, `${source}.retry`);
    config.retry = {};
    if (retry.maxAttempts !== undefined)
      config.retry.maxAttempts = asNumber(retry.maxAttempts, `${source}.retry.maxAttempts`);
    if (retry.baseDelayMs !== undefined)
      config.retry.baseDelayMs = asNumber(retry.baseDelayMs, `${source}.retry.baseDelayMs`);
    if (retry.factor !== undefined) config.retry.factor = asNumber(retry.factor, `${source}.retry.factor`);
    if (retry.maxDelayMs !== undefined)
      config.retry.maxDelayMs = asNumber(retry.maxDelayMs, `${source}.retry.maxDelayMs`);
  }

  if (root.autoPrune !== undefined) {
    const autoPrune = asObject(root.autoPrune, `${source}.autoPrune`);
    config.autoPrune = {};
    if (autoPrune.enabled !== undefined)
      config.autoPrune.enabled = asBool(autoPrune.enabled, `${source}.autoPrune.enabled`);
    if (autoPrune.after !== undefined) config.autoPrune.after = asString(autoPrune.after, `${source}.autoPrune.after`);
    if (autoPrune.keep !== undefined) config.autoPrune.keep = asNumber(autoPrune.keep, `${source}.autoPrune.keep`);
    if (autoPrune.every !== undefined) config.autoPrune.every = asString(autoPrune.every, `${source}.autoPrune.every`);
    if (autoPrune.everyTicks !== undefined)
      config.autoPrune.everyTicks = asNumber(autoPrune.everyTicks, `${source}.autoPrune.everyTicks`);
  }

  return config;
}

/** Severity of a {@link ConfigIssue}. Errors fail validation; warnings don't. */
export type ConfigIssueLevel = "error" | "warning";

/**
 * A single problem found by {@link validateConfig}. `path` is the dotted
 * location within the config (e.g. `retry.factor`) so users can jump straight
 * to the offending field.
 */
export interface ConfigIssue {
  level: ConfigIssueLevel;
  path: string;
  message: string;
}

/**
 * Semantically validates an already-structurally-valid {@link AgentRelayConfig}
 * (i.e. one that passed {@link parseConfig}, so every field has the right type)
 * and returns a list of issues — empty when everything is sane.
 *
 * `parseConfig` only rejects *type* mistakes (a string where a number belongs).
 * This catches values that are the right type but nonsensical: a negative
 * `maxAttempts`, a `factor` below 1 that would make backoff shrink instead of
 * grow, an `after`/`every` duration the prune parser can't understand, a
 * webhook URL that isn't http(s). Errors mean the config would misbehave;
 * warnings flag likely mistakes that still "work".
 *
 * Pure — no filesystem, no env — so the CLI `config validate` command and tests
 * share exactly the same rules.
 */
export function validateConfig(config: AgentRelayConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const error = (path: string, message: string) => issues.push({ level: "error", path, message });
  const warn = (path: string, message: string) => issues.push({ level: "warning", path, message });

  if (config.store !== undefined && config.store.trim() === "") {
    warn("store", "is empty; the built-in default store path will be used instead");
  }

  const slack = config.notify?.slackWebhook;
  if (slack && !isHttpUrl(slack)) {
    warn("notify.slackWebhook", "does not look like an http(s) URL; Slack webhooks start with https://");
  }
  const webhook = config.notify?.webhookUrl;
  if (webhook && !isHttpUrl(webhook)) {
    error("notify.webhookUrl", "is not a valid http(s) URL");
  }

  const retry = config.retry;
  if (retry) {
    checkInteger(issues, "retry.maxAttempts", retry.maxAttempts, { min: 0 });
    checkInteger(issues, "retry.baseDelayMs", retry.baseDelayMs, { min: 0 });
    checkInteger(issues, "retry.maxDelayMs", retry.maxDelayMs, { min: 0 });
    if (retry.factor !== undefined && retry.factor < 1) {
      error("retry.factor", "must be at least 1, otherwise the backoff delay would shrink each attempt");
    }
    if (
      retry.baseDelayMs !== undefined &&
      retry.maxDelayMs !== undefined &&
      retry.maxDelayMs > 0 &&
      retry.maxDelayMs < retry.baseDelayMs
    ) {
      warn(
        "retry.maxDelayMs",
        "is smaller than retry.baseDelayMs, so the delay cap clamps every attempt to the same value"
      );
    }
  }

  const autoPrune = config.autoPrune;
  if (autoPrune) {
    if (autoPrune.after !== undefined && parseDuration(autoPrune.after) === null) {
      error("autoPrune.after", `is not a valid duration like "7d", "24h", "30m", "90s" or "500ms"`);
    }
    if (autoPrune.every !== undefined && parseDuration(autoPrune.every) === null) {
      error("autoPrune.every", `is not a valid duration like "1h", "30m" or "90s"`);
    }
    checkInteger(issues, "autoPrune.keep", autoPrune.keep, { min: 0 });
    checkInteger(issues, "autoPrune.everyTicks", autoPrune.everyTicks, { min: 0 });
  }

  return issues;
}

/** True when at least one issue is an error (validation should be treated as failed). */
export function hasConfigErrors(issues: ConfigIssue[]): boolean {
  return issues.some((issue) => issue.level === "error");
}

function checkInteger(issues: ConfigIssue[], path: string, value: number | undefined, { min }: { min: number }): void {
  if (value === undefined) return;
  if (!Number.isInteger(value)) {
    issues.push({ level: "error", path, message: "must be a whole number" });
    return;
  }
  if (value < min) {
    issues.push({ level: "error", path, message: `must be ${min} or greater` });
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Projects a config object onto the `AGENTRELAY_*` environment variables that
 * the existing `*FromEnv` helpers already read. Only fields that are actually
 * set produce an entry, so an empty config yields an empty map. This is the
 * single mapping point between the file schema and the env-driven internals.
 */
export function configToEnv(config: AgentRelayConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const set = (key: string, value: string | number | undefined) => {
    if (value === undefined) return;
    env[key] = String(value);
  };

  set("AGENTRELAY_STORE", config.store);

  set("AGENTRELAY_SLACK_WEBHOOK", config.notify?.slackWebhook);
  set("AGENTRELAY_WEBHOOK_URL", config.notify?.webhookUrl);
  set("AGENTRELAY_WEBHOOK_AUTH", config.notify?.webhookAuth);

  set("AGENTRELAY_MAX_ATTEMPTS", config.retry?.maxAttempts);
  set("AGENTRELAY_RETRY_BASE_MS", config.retry?.baseDelayMs);
  set("AGENTRELAY_RETRY_FACTOR", config.retry?.factor);
  set("AGENTRELAY_RETRY_MAX_MS", config.retry?.maxDelayMs);

  // The opt-in flag is boolean in the file but "1"/"0" in the env layer.
  if (config.autoPrune?.enabled !== undefined) {
    env.AGENTRELAY_AUTOPRUNE = config.autoPrune.enabled ? "1" : "0";
  }
  set("AGENTRELAY_AUTOPRUNE_AFTER", config.autoPrune?.after);
  set("AGENTRELAY_AUTOPRUNE_KEEP", config.autoPrune?.keep);
  set("AGENTRELAY_AUTOPRUNE_EVERY", config.autoPrune?.every);
  set("AGENTRELAY_AUTOPRUNE_EVERY_TICKS", config.autoPrune?.everyTicks);

  return env;
}

/** Logical grouping of an {@link AgentRelayConfig} env var, used for display. */
export type ConfigGroup = "store" | "notify" | "retry" | "autoPrune";

/**
 * Metadata for one `AGENTRELAY_*` env var that the config file can populate.
 * The list mirrors exactly the keys {@link configToEnv} can emit — a test
 * asserts they stay in sync, so `config show` never silently omits a setting.
 */
export interface ConfigEnvKey {
  key: string;
  group: ConfigGroup;
  /** Values that shouldn't be printed in full (webhook URLs / auth tokens). */
  secret?: boolean;
}

/** Every config-backed env var, in display order (grouped by concern). */
export const CONFIG_ENV_KEYS: ConfigEnvKey[] = [
  { key: "AGENTRELAY_STORE", group: "store" },
  { key: "AGENTRELAY_SLACK_WEBHOOK", group: "notify", secret: true },
  { key: "AGENTRELAY_WEBHOOK_URL", group: "notify", secret: true },
  { key: "AGENTRELAY_WEBHOOK_AUTH", group: "notify", secret: true },
  { key: "AGENTRELAY_MAX_ATTEMPTS", group: "retry" },
  { key: "AGENTRELAY_RETRY_BASE_MS", group: "retry" },
  { key: "AGENTRELAY_RETRY_FACTOR", group: "retry" },
  { key: "AGENTRELAY_RETRY_MAX_MS", group: "retry" },
  { key: "AGENTRELAY_AUTOPRUNE", group: "autoPrune" },
  { key: "AGENTRELAY_AUTOPRUNE_AFTER", group: "autoPrune" },
  { key: "AGENTRELAY_AUTOPRUNE_KEEP", group: "autoPrune" },
  { key: "AGENTRELAY_AUTOPRUNE_EVERY", group: "autoPrune" },
  { key: "AGENTRELAY_AUTOPRUNE_EVERY_TICKS", group: "autoPrune" },
];

/** Where an effective config value came from, in precedence order. */
export type ConfigValueSource = "env" | "config-file" | "default";

/** One resolved setting: its effective value and which layer supplied it. */
export interface EffectiveConfigEntry {
  key: string;
  group: ConfigGroup;
  /** The effective value, or `undefined` when the built-in default applies. */
  value: string | undefined;
  source: ConfigValueSource;
  secret: boolean;
}

/**
 * Resolves every config-backed setting to its *effective* value and source,
 * applying the same precedence the app uses at runtime: an explicit
 * `AGENTRELAY_*` env var wins over the config file, which wins over the
 * built-in default (reported as `source: "default"`, `value: undefined`).
 *
 * Pure — no filesystem, no ambient env unless `env` is omitted — so the CLI
 * `config show` command and tests share exactly this resolution. This is the
 * read-only mirror of {@link applyConfigToEnv}, which does the actual filling.
 */
export function resolveEffectiveConfig(
  fileConfig: AgentRelayConfig | null,
  env: Record<string, string | undefined> = process.env
): EffectiveConfigEntry[] {
  const fileEnv = fileConfig ? configToEnv(fileConfig) : {};
  return CONFIG_ENV_KEYS.map(({ key, group, secret }): EffectiveConfigEntry => {
    const flag = Boolean(secret);
    if (env[key] !== undefined) return { key, group, value: env[key], source: "env", secret: flag };
    if (fileEnv[key] !== undefined) return { key, group, value: fileEnv[key], source: "config-file", secret: flag };
    return { key, group, value: undefined, source: "default", secret: flag };
  });
}

/** One resolved setting, addressed by its dotted CLI key (what `config get` returns). */
export interface ResolvedConfigValue {
  /** Dotted CLI key, e.g. `retry.maxAttempts`. */
  key: string;
  /** The `AGENTRELAY_*` env var this key projects onto. */
  envKey: string;
  group: ConfigGroup;
  /** The effective value, or `undefined` when the built-in default applies. */
  value: string | undefined;
  source: ConfigValueSource;
  secret: boolean;
}

/**
 * Resolves a *single* setting (addressed by its dotted CLI key, the same key
 * `config set`/`unset` take) to its effective value and source, using the same
 * env > config-file > default precedence as {@link resolveEffectiveConfig}.
 * Returns `null` for an unknown key so the caller can report it. Pure — no
 * filesystem — so `config get` and its tests share exactly this logic.
 */
export function getEffectiveConfigValue(
  key: string,
  fileConfig: AgentRelayConfig | null,
  env: Record<string, string | undefined> = process.env
): ResolvedConfigValue | null {
  const field = findConfigField(key);
  if (!field) return null;
  const entry = resolveEffectiveConfig(fileConfig, env).find((e) => e.key === field.envKey);
  // `field.envKey` always names an entry (a test asserts CONFIG_FIELDS ⊆
  // CONFIG_ENV_KEYS), but fall back defensively rather than assert non-null.
  if (!entry) {
    return {
      key,
      envKey: field.envKey,
      group: field.group,
      value: undefined,
      source: "default",
      secret: Boolean(field.secret),
    };
  }
  return {
    key,
    envKey: field.envKey,
    group: entry.group,
    value: entry.value,
    source: entry.source,
    secret: entry.secret,
  };
}

/**
 * Fills the derived config values into `targetEnv` (defaults to `process.env`)
 * *without overwriting anything already set*, so an explicit environment
 * variable always beats the file. Mutates `targetEnv` in place and returns the
 * list of keys it actually applied (useful for a "loaded config" log line).
 */
export function applyConfigToEnv(
  config: AgentRelayConfig,
  targetEnv: Record<string, string | undefined> = process.env
): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(configToEnv(config))) {
    if (targetEnv[key] === undefined) {
      targetEnv[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function asBool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}
