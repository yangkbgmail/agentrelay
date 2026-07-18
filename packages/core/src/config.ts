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
