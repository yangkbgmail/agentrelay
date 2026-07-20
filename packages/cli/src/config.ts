// Shared with the dashboard via @agentrelay/core so every entry point
// resolves the same store file.
import type { ConfigGroup, EffectiveConfigEntry } from "@agentrelay/core";
import { applyConfigToEnv, loadConfigFile } from "@agentrelay/core";
import type { ConfigGetResult, ConfigShowResult } from "./commands.js";

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

/** `config` subcommands that must run without the startup {@link bootstrapConfig}. */
const BOOTSTRAP_SKIP_SUBCOMMANDS = new Set(["validate", "show", "get", "set", "unset"]);

/**
 * True when argv invokes a `config` subcommand that must run *without* the
 * startup {@link bootstrapConfig}:
 *
 * - `validate` diagnoses a possibly-malformed file; bootstrap throws on one,
 *   which would abort before validate can report the problem.
 * - `show`/`get` report the env > file > default precedence; bootstrap would
 *   fold the config file's values into `process.env` first, making them all
 *   look like they came from the environment. Skipping it keeps the layers
 *   distinct (both load the file themselves to attribute each value).
 * - `set`/`unset` edit the file directly; bootstrap would abort on a malformed
 *   existing file before the command can report its own clear error, and its
 *   env-folding is irrelevant since these commands never read env-driven options.
 */
export function isConfigDiagnosticInvocation(argv: string[] = process.argv): boolean {
  const args = subcommandTokens(argv);
  return args[0] === "config" && BOOTSTRAP_SKIP_SUBCOMMANDS.has(args[1]);
}

/** Global program options that consume the following argv token as their value. */
const VALUE_OPTIONS = new Set(["--store", "--config"]);

/**
 * The positional command tokens from argv, with flags and their values removed —
 * e.g. `["--config", "x.json", "config", "show"]` → `["config", "show"]`. This
 * matters because a global `--config <path>`/`--store <path>` sits *before* the
 * subcommand, and its value would otherwise be mistaken for the command name.
 */
function subcommandTokens(argv: string[]): string[] {
  const rest = argv.slice(2);
  const tokens: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (VALUE_OPTIONS.has(arg)) {
      i++; // skip the option's value token too
      continue;
    }
    if (arg.startsWith("-")) continue; // bare flag or --opt=value form
    tokens.push(arg);
  }
  return tokens;
}

/** @deprecated Use {@link isConfigDiagnosticInvocation}. Kept for compatibility. */
export function isConfigValidateInvocation(argv: string[] = process.argv): boolean {
  return isConfigDiagnosticInvocation(argv);
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

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Human-readable heading for each config group, in display order. */
const GROUP_LABELS: Record<ConfigGroup, string> = {
  store: "store",
  notify: "notify",
  retry: "retry",
  autoPrune: "auto-prune",
};
const GROUP_ORDER: ConfigGroup[] = ["store", "notify", "retry", "autoPrune"];

/**
 * Masks a secret value (webhook URL / auth token) for terminal display, keeping
 * enough of a hint (length + last 4 chars) to recognize it without leaking it
 * into scrollback or a screen share. Short secrets are fully hidden.
 */
export function maskSecret(value: string): string {
  if (value.length <= 4) return "•".repeat(value.length);
  return `${"•".repeat(value.length - 4)}${value.slice(-4)}`;
}

/**
 * Renders {@link showConfig}'s result as a grouped, aligned table showing each
 * setting's effective value and where it came from (env / config-file /
 * default). Pure: no I/O. `color` gates ANSI codes (TTY only); `showSecrets`
 * reveals webhook URLs/tokens that are otherwise masked.
 */
export function renderEffectiveConfig(
  result: ConfigShowResult,
  options: { color?: boolean; showSecrets?: boolean } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  lines.push(b("effective configuration") + d(" (env > config file > default)"));
  if (result.path) {
    lines.push(d(`config file: ${result.path}`));
  } else {
    lines.push(d("config file: none (using env vars and built-in defaults)"));
  }
  if (result.loadError) {
    lines.push(`  warning: config file could not be loaded — ${result.loadError}`);
  }

  const keyWidth = Math.max(...result.entries.map((e) => e.key.length));
  for (const group of GROUP_ORDER) {
    const entries = result.entries.filter((e) => e.group === group);
    if (entries.length === 0) continue;
    lines.push("");
    lines.push(b(GROUP_LABELS[group]));
    for (const entry of entries) {
      lines.push(
        `  ${entry.key.padEnd(keyWidth)}  ${renderValue(entry, options.showSecrets ?? false)}  ${d(`[${entry.source}]`)}`
      );
    }
  }

  return lines.join("\n");
}

/** Formats a single entry's value: "(default)" when unset, masked when secret. */
function renderValue(entry: EffectiveConfigEntry, showSecrets: boolean): string {
  if (entry.value === undefined) return "(default)";
  if (entry.secret && !showSecrets) return maskSecret(entry.value);
  return entry.value;
}

/** Machine-readable snapshot for `config show --json` (scripts, jq, tooling). */
export function renderEffectiveConfigJson(
  result: ConfigShowResult,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify({ generatedAt, ...result }, null, 2);
}

/**
 * Renders a single resolved config value for `config get <key>` — plain output
 * meant to be captured by scripts (`store=$(agentrelay config get store)`). By
 * default it prints *only* the value (nothing when the built-in default
 * applies, so an unset key yields an empty capture rather than a label). With
 * `withSource` it appends the origin in brackets so a human can see where the
 * value came from without reaching for `--json`. Never masks — the user named
 * this exact key, so `get` hands back the real value scripts need.
 */
export function renderConfigGet(result: ConfigGetResult, options: { withSource?: boolean } = {}): string {
  const value = result.value ?? "";
  if (options.withSource) {
    return `${value}\t[${result.source ?? "default"}]`;
  }
  return value;
}

/** Machine-readable snapshot for `config get <key> --json`. */
export function renderConfigGetJson(result: ConfigGetResult, generatedAt: string = new Date().toISOString()): string {
  return JSON.stringify({ generatedAt, ...result }, null, 2);
}
