import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Optional config file support.
 *
 * Every tunable in AgentRelay is read from an environment variable (see the
 * `*FromEnv` helpers). That is great for one-off overrides but tedious as a way
 * to persist your preferences — you either export a dozen vars in your shell
 * profile or prefix every command. A config file lets you set those defaults
 * once, in one place (`~/.agentrelay/config.json`), while keeping env vars as
 * the higher-precedence, per-invocation override.
 *
 * Precedence (highest first):
 *   1. a real environment variable (`AGENTRELAY_*`)
 *   2. the config file
 *   3. the built-in default baked into each `*FromEnv` helper
 *
 * The file uses friendly camelCase keys (see {@link CONFIG_KEY_TO_ENV}) rather
 * than raw env-var names, and accepts strings, numbers, or booleans — all
 * coerced to the string form the env parsers already understand. Unknown keys
 * are reported (not silently dropped) so a typo is visible instead of quietly
 * doing nothing.
 */

/** Friendly config-file key → the environment variable it maps onto. */
export const CONFIG_KEY_TO_ENV = {
  store: "AGENTRELAY_STORE",
  slackWebhook: "AGENTRELAY_SLACK_WEBHOOK",
  webhookUrl: "AGENTRELAY_WEBHOOK_URL",
  webhookAuth: "AGENTRELAY_WEBHOOK_AUTH",
  maxAttempts: "AGENTRELAY_MAX_ATTEMPTS",
  retryBaseMs: "AGENTRELAY_RETRY_BASE_MS",
  retryFactor: "AGENTRELAY_RETRY_FACTOR",
  retryMaxMs: "AGENTRELAY_RETRY_MAX_MS",
  autoPrune: "AGENTRELAY_AUTOPRUNE",
  autoPruneAfter: "AGENTRELAY_AUTOPRUNE_AFTER",
  autoPruneKeep: "AGENTRELAY_AUTOPRUNE_KEEP",
  autoPruneEvery: "AGENTRELAY_AUTOPRUNE_EVERY",
  autoPruneEveryTicks: "AGENTRELAY_AUTOPRUNE_EVERY_TICKS",
} as const;

export type ConfigKey = keyof typeof CONFIG_KEY_TO_ENV;

/** Recognized config-file shape. Values may be given as string/number/boolean. */
export type AgentRelayConfig = Partial<Record<ConfigKey, string | number | boolean>>;

/** Result of reading & validating a config file. */
export interface LoadedConfig {
  /** Recognized settings only. */
  config: AgentRelayConfig;
  /** Keys present in the file that AgentRelay does not recognize. */
  unknownKeys: string[];
  /** Absolute path the config was read from. */
  path: string;
}

const KNOWN_KEYS = new Set<string>(Object.keys(CONFIG_KEY_TO_ENV));

/**
 * Resolves the config file location: `AGENTRELAY_CONFIG` override, otherwise
 * `~/.agentrelay/config.json` (same directory as the default job store).
 */
export function configFilePath(env: Record<string, string | undefined> = process.env): string {
  const override = env.AGENTRELAY_CONFIG?.trim();
  if (override) return override;
  return join(homedir(), ".agentrelay", "config.json");
}

/**
 * Parses raw JSON config text into recognized settings plus any unknown keys.
 * Throws a clear error on malformed JSON or a non-object top level, so a broken
 * config surfaces loudly instead of being ignored.
 */
export function parseConfig(raw: string): { config: AgentRelayConfig; unknownKeys: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config file is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Config file must contain a JSON object.");
  }

  const config: AgentRelayConfig = {};
  const unknownKeys: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KNOWN_KEYS.has(key)) {
      unknownKeys.push(key);
      continue;
    }
    if (value === null || value === undefined) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`Config key "${key}" must be a string, number, or boolean.`);
    }
    config[key as ConfigKey] = value;
  }
  return { config, unknownKeys };
}

/** Converts a recognized config object into an `AGENTRELAY_*` env-var overlay. */
export function configToEnv(config: AgentRelayConfig): Record<string, string> {
  const overlay: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue;
    const envName = CONFIG_KEY_TO_ENV[key as ConfigKey];
    if (!envName) continue;
    overlay[envName] = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  }
  return overlay;
}

/**
 * Overlays config-derived values UNDER an existing env map: a real env var
 * always wins, and config only fills entries that are currently unset. Returns
 * a new object; the input env is never mutated.
 */
export function applyConfigToEnv(
  config: AgentRelayConfig,
  env: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  const overlay = configToEnv(config);
  const merged: Record<string, string | undefined> = { ...env };
  for (const [name, value] of Object.entries(overlay)) {
    if (merged[name] === undefined) merged[name] = value;
  }
  return merged;
}

const defaultReadFile = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
};

/**
 * Reads the config file (if any) for the given env. Returns `null` when no file
 * exists, so a missing config is the normal, silent case. Throws on malformed
 * content. `readFile` is injectable for testing.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string | null = defaultReadFile
): LoadedConfig | null {
  const path = configFilePath(env);
  const raw = readFile(path);
  if (raw === null) return null;
  const { config, unknownKeys } = parseConfig(raw);
  return { config, unknownKeys, path };
}

/**
 * Convenience one-shot used by the CLI: load the config file and return an
 * effective env map with config values layered under the real env. When no file
 * exists the input env is returned unchanged. `onLoad` is invoked with the
 * loaded result (for logging unknown keys, etc.).
 */
export function resolveEnvWithConfig(
  env: Record<string, string | undefined> = process.env,
  options: { readFile?: (path: string) => string | null; onLoad?: (loaded: LoadedConfig) => void } = {}
): Record<string, string | undefined> {
  const loaded = loadConfig(env, options.readFile);
  if (!loaded) return env;
  options.onLoad?.(loaded);
  return applyConfigToEnv(loaded.config, env);
}
