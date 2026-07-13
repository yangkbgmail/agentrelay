// Shared with the dashboard via @agentrelay/core so every entry point
// resolves the same store file.
import {
  CONFIG_KEY_TO_ENV,
  type ConfigKey,
  configFilePath,
  configToEnv,
  type LoadedConfig,
  loadConfig,
} from "@agentrelay/core";

export { defaultStorePath } from "@agentrelay/core";

/** Env vars whose values are secrets/URLs and should be masked when printed. */
const SECRET_ENV_VARS = new Set<string>([
  CONFIG_KEY_TO_ENV.slackWebhook,
  CONFIG_KEY_TO_ENV.webhookUrl,
  CONFIG_KEY_TO_ENV.webhookAuth,
]);

function maskSecret(value: string): string {
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;
}

/**
 * Human-readable summary for `agentrelay config`: where the config file lives,
 * whether it loaded, its recognized settings and any unknown keys, plus the
 * effective `AGENTRELAY_*` values currently in the environment (secrets masked).
 * Pure — takes the loaded config and env so it is trivially testable.
 */
export function renderConfig(loaded: LoadedConfig | null, env: NodeJS.ProcessEnv = process.env): string {
  const lines: string[] = [];
  const path = configFilePath(env);
  lines.push(`Config file: ${path}`);

  if (!loaded) {
    lines.push("  (not found — using environment variables and built-in defaults)");
  } else {
    const entries = Object.entries(loaded.config) as [ConfigKey, string | number | boolean][];
    if (entries.length === 0) {
      lines.push("  (loaded, but no recognized settings)");
    } else {
      lines.push("  Recognized settings:");
      for (const [key, value] of entries) {
        const printed = SECRET_ENV_VARS.has(CONFIG_KEY_TO_ENV[key]) ? maskSecret(String(value)) : String(value);
        lines.push(`    ${key} = ${printed}`);
      }
    }
    if (loaded.unknownKeys.length > 0) {
      lines.push(`  Unknown keys (ignored): ${loaded.unknownKeys.join(", ")}`);
    }
  }

  lines.push("");
  lines.push("Effective settings (AGENTRELAY_* environment, config already applied):");
  const set = Object.entries(CONFIG_KEY_TO_ENV)
    .map(([key, envVar]) => [key, envVar, env[envVar]] as const)
    .filter(([, , v]) => v !== undefined && v !== "");
  if (set.length === 0) {
    lines.push("  (none set — all built-in defaults)");
  } else {
    for (const [key, envVar, value] of set) {
      const printed = SECRET_ENV_VARS.has(envVar) ? maskSecret(value as string) : (value as string);
      lines.push(`  ${key} (${envVar}) = ${printed}`);
    }
  }
  return lines.join("\n");
}

export function resolveProjectName(cwd: string): string {
  // Last path segment is good enough for a human-readable project label.
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/**
 * Loads `~/.agentrelay/config.json` (or `AGENTRELAY_CONFIG`) and layers its
 * values UNDER the current `process.env`: a real env var always wins, config
 * only fills entries that are unset. Mutates `process.env` in place so every
 * downstream `*FromEnv()` call and the `--store` default pick up the values
 * without threading an env map through the whole CLI. Unknown config keys are
 * warned about (never silently dropped). Returns the loaded config, or `null`
 * when no file exists. A malformed file throws (surfaced by the caller).
 */
export function applyConfigFile(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (m) => console.error(m)
): LoadedConfig | null {
  const loaded = loadConfig(env);
  if (!loaded) return null;
  if (loaded.unknownKeys.length > 0) {
    warn(`[agentrelay] Ignoring unknown config key(s) in ${loaded.path}: ${loaded.unknownKeys.join(", ")}`);
  }
  const overlay = configToEnv(loaded.config);
  for (const [name, value] of Object.entries(overlay)) {
    if (env[name] === undefined) env[name] = value;
  }
  return loaded;
}
