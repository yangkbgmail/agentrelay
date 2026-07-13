// Shared with the dashboard via @agentrelay/core so every entry point
// resolves the same store file.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  applyConfigToEnv,
  buildSampleConfig,
  CONFIG_FILENAME,
  loadConfigFile,
  serializeConfig,
} from "@agentrelay/core";

export { defaultStorePath } from "@agentrelay/core";

export function resolveProjectName(cwd: string): string {
  // Last path segment is good enough for a human-readable project label.
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/**
 * Extracts an explicit config path from argv (`--config <path>` or
 * `--config=<path>`) before commander parses, so it can be honored while
 * building the CLI. Returns undefined when the flag is absent.
 */
export function configPathFromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") return argv[i + 1];
    if (arg.startsWith("--config=")) return arg.slice("--config=".length);
  }
  return undefined;
}

/**
 * Loads the config file (if any) and fills its values into `process.env`
 * *without overwriting* variables already set, so explicit env/CLI values win.
 * Runs once at startup before the CLI reads any env-driven option. Returns the
 * loaded file path, or null when no config was found. A malformed config throws
 * (surfaced by the top-level catch in bin.ts) rather than being ignored.
 */
export function bootstrapConfig(argv: string[] = process.argv): string | null {
  const loaded = loadConfigFile({ path: configPathFromArgv(argv) });
  if (!loaded) return null;
  applyConfigToEnv(loaded.config);
  return loaded.path;
}

export interface ConfigInitOptions {
  /** Explicit target path (from a positional arg or `--config`). */
  path?: string;
  /** Directory used when no explicit path is given. Defaults to `process.cwd()`. */
  cwd?: string;
  /** `store` value baked into the generated file. Defaults to the sample's own. */
  store?: string;
  /** Overwrite an existing file instead of refusing. */
  force?: boolean;
}

export interface ConfigInitResult {
  ok: boolean;
  /** Absolute-or-relative path the sample was (or would be) written to. */
  path: string;
  /** True when the file was actually written. */
  written: boolean;
  message: string;
}

/**
 * Resolves the file `config init` should write to: an explicit path (used
 * verbatim if absolute, else relative to `cwd`), otherwise
 * `<cwd>/agentrelay.config.json`.
 */
export function resolveConfigInitPath(options: { path?: string; cwd?: string } = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const explicit = options.path?.trim();
  if (explicit) return isAbsolute(explicit) ? explicit : join(cwd, explicit);
  return join(cwd, CONFIG_FILENAME);
}

/**
 * Writes a documented sample `agentrelay.config.json`. Refuses to clobber an
 * existing file unless `force` is set, and creates any missing parent
 * directories. Returns a structured result so the CLI can set an exit code and
 * print a message without doing filesystem work itself.
 */
export function initConfigFile(options: ConfigInitOptions = {}): ConfigInitResult {
  const target = resolveConfigInitPath(options);
  if (existsSync(target) && !options.force) {
    return {
      ok: false,
      path: target,
      written: false,
      message: `Config already exists at ${target}. Use --force to overwrite.`,
    };
  }
  const dir = dirname(target);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(target, serializeConfig(buildSampleConfig({ store: options.store })), "utf8");
  return {
    ok: true,
    path: target,
    written: true,
    message: `Wrote sample config to ${target}. Edit it, then run any agentrelay command.`,
  };
}
