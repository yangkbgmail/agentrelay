// Shared with the dashboard via @agentrelay/core so every entry point
// resolves the same store file.
import { applyConfigToEnv, loadConfigFile } from "@agentrelay/core";

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
