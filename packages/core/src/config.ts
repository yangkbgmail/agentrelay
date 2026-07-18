import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
 * A representative starter config with every field filled in using AgentRelay's
 * built-in defaults (retry/auto-prune) and obvious placeholders (store/notify),
 * so `agentrelay config init` produces a file the user only has to *edit* rather
 * than author from scratch. It is itself a valid {@link AgentRelayConfig} and
 * round-trips cleanly through {@link parseConfig}.
 */
export const SAMPLE_CONFIG: AgentRelayConfig = {
  store: "~/.agentrelay/jobs.json",
  notify: {
    slackWebhook: "https://hooks.slack.com/services/XXXX/YYYY/ZZZZ",
    webhookUrl: "https://example.com/agentrelay-webhook",
    webhookAuth: "Bearer your-token",
  },
  retry: {
    maxAttempts: 5,
    baseDelayMs: 60000,
    factor: 2,
    maxDelayMs: 3600000,
  },
  autoPrune: {
    enabled: false,
    after: "7d",
    keep: 50,
    every: "1h",
    everyTicks: 20,
  },
};

/**
 * Serializes a config to the exact text `config init` writes: 2-space indented
 * JSON with a trailing newline, and a leading `"//"` note key that documents the
 * file. JSON has no comment syntax, but the note is an unknown key that
 * {@link parseConfig} ignores, so the emitted file still loads without error.
 */
export function serializeConfig(config: AgentRelayConfig = SAMPLE_CONFIG): string {
  const withNote = {
    "//": "AgentRelay config. Every field is optional; delete the ones you don't need. Explicit AGENTRELAY_* env vars and CLI flags always win over this file.",
    ...config,
  };
  return `${JSON.stringify(withNote, null, 2)}\n`;
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
