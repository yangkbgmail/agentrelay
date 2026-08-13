// Renders the `agentrelay env` command: a reference of every environment
// variable AgentRelay reads, with each var's current state (set/unset),
// redacted value, source hint, and a one-line description. Pure functions
// (no TTY, clock, or filesystem) so they're unit-testable; the CLI wires the
// live environment in.
import type { EnvVarCategory, EnvVarState } from "@agentrelay/core";
import { describeEnv } from "@agentrelay/core";
import { maskSecret } from "./config.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";

/** Display order + human labels for the categories, grouped by concern. */
const CATEGORY_ORDER: EnvVarCategory[] = ["store", "config", "notify", "retry", "scheduler", "autoPrune"];
const CATEGORY_LABELS: Record<EnvVarCategory, string> = {
  store: "store",
  config: "config file",
  notify: "notifications",
  retry: "retry / backoff",
  scheduler: "scheduler",
  autoPrune: "auto-prune",
};

export interface RenderEnvOptions {
  /** Gate ANSI colour (TTY only). */
  color?: boolean;
  /** Reveal secret values in full instead of masking them. */
  showSecrets?: boolean;
}

/** Formats one var's effective value column: the value, "(unset)", or a masked secret. */
function renderValue(state: EnvVarState, showSecrets: boolean): string {
  if (!state.set || state.value === undefined) return "(unset)";
  if (state.secret && !showSecrets) return maskSecret(state.value);
  return state.value;
}

/**
 * Renders the env reference as a grouped, aligned table. For each var: name,
 * effective value (masked when secret), a `[set]`/`[default]` source tag, then
 * the description and — when unset — the built-in default it falls back to.
 * Pure: no I/O.
 */
export function renderEnv(states: EnvVarState[], options: RenderEnvOptions = {}): string {
  const color = options.color ?? false;
  const showSecrets = options.showSecrets ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);
  const g = (s: string) => (color ? `${GREEN}${s}${RESET}` : s);

  const setCount = states.filter((s) => s.set).length;
  const lines: string[] = [];
  lines.push(b("environment variables") + d(` (${setCount} of ${states.length} set)`));

  const keyWidth = Math.max(...states.map((s) => s.key.length));
  const valueWidth = Math.max(...states.map((s) => renderValue(s, showSecrets).length));

  for (const category of CATEGORY_ORDER) {
    const group = states.filter((s) => s.category === category);
    if (group.length === 0) continue;
    lines.push("");
    lines.push(b(CATEGORY_LABELS[category]));
    for (const state of group) {
      const value = renderValue(state, showSecrets);
      const source = state.set ? g("[set]") : d("[default]");
      lines.push(`  ${state.key.padEnd(keyWidth)}  ${value.padEnd(valueWidth)}  ${source}`);
      lines.push(`  ${" ".repeat(keyWidth)}  ${d(state.description)}`);
      if (!state.set && state.defaultHint) {
        lines.push(`  ${" ".repeat(keyWidth)}  ${d(`default: ${state.defaultHint}`)}`);
      }
    }
  }

  return lines.join("\n");
}

/** Machine-readable snapshot for `agentrelay env --json` (scripts, jq, tooling). */
export function renderEnvJson(
  states: EnvVarState[],
  options: { showSecrets?: boolean; generatedAt?: string } = {}
): string {
  const showSecrets = options.showSecrets ?? false;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const vars = states.map((s) => ({
    key: s.key,
    category: s.category,
    description: s.description,
    configBacked: s.configBacked,
    secret: Boolean(s.secret),
    default: s.defaultHint ?? null,
    set: s.set,
    // Redact secret values by default even in JSON; --show-secrets opts out.
    value: s.value === undefined ? null : s.secret && !showSecrets ? maskSecret(s.value) : s.value,
  }));
  return JSON.stringify({ generatedAt, total: states.length, set: states.filter((s) => s.set).length, vars }, null, 2);
}

/**
 * Convenience used by the CLI: resolve the live environment and render text or
 * JSON. Kept thin so the pure renderers above carry the testable logic.
 */
export function runEnv(
  options: RenderEnvOptions & { json?: boolean; env?: Record<string, string | undefined> } = {}
): string {
  const states = describeEnv(options.env);
  if (options.json) return renderEnvJson(states, { showSecrets: options.showSecrets });
  return renderEnv(states, options);
}
