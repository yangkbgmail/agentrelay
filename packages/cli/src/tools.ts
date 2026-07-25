// Rendering for `agentrelay tools` — the catalog of registered agent adapters.
// `parse` tests one message against the parser; this answers the more basic
// "which tools does AgentRelay know about?" — the valid `--tool` values, which
// argv[0] binaries auto-infer a tool for `run`, and which tools teach the parser
// extra rate-limit wording beyond the generic patterns. Pure functions (separate
// from the commander wiring in cli.ts) so the output is unit-testable without a
// TTY.

import type { AdapterInfo } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

/**
 * Human-readable block: one stanza per adapter with its `--tool` id, the
 * binaries that auto-infer it, and the tool-specific parser patterns it adds.
 * Pure — no ambient color unless `color` is passed.
 */
export function renderTools(adapters: AdapterInfo[], options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const c = (s: string): string => (color ? `${CYAN}${s}${RESET}` : s);

  const lines: string[] = [b("Registered agent adapters")];
  for (const a of adapters) {
    const fallback = a.isFallback ? ` ${d("(default when no tool given / inferred)")}` : "";
    lines.push(`  ${c(a.tool)}  ${a.displayName}${fallback}`);

    const binaries = a.binaries.length > 0 ? a.binaries.join(", ") : d("(none — pass --tool explicitly)");
    lines.push(`      binaries: ${binaries}`);

    const patterns =
      a.patternNames.length > 0 ? a.patternNames.join(", ") : d("(generic parser only — no tool-specific patterns)");
    lines.push(`      patterns: ${patterns}`);
  }
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq): the adapter list plus when it
 * was generated.
 */
export function renderToolsJson(adapters: AdapterInfo[], generatedAt: string = new Date().toISOString()): string {
  return JSON.stringify({ generatedAt, adapters }, null, 2);
}
