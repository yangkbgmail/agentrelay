// Rendering helpers for `agentrelay tools` — a static listing of which AI coding
// CLIs AgentRelay understands (its agent adapters): each tool's id, display
// name, the argv[0] binaries that auto-infer it, and the tool-specific
// rate-limit patterns it adds on top of the generic parser. Unlike `patterns`
// (which counts what actually fired across the queue), this is the fixed
// registry — answering "what can I pass to --tool, and what does each recognize?"
// Pure functions here, separate from the commander wiring, so the exact output
// is unit-testable without a store or a clock.

import type { AdapterDescription } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Render the adapter registry as a human-readable block: one entry per tool
 * (id, display name, inferring binaries, tool-specific patterns), followed by
 * the shared generic patterns every tool falls back to. Pure: no I/O, no clock.
 * `color` gates ANSI codes (TTY only).
 */
export function renderTools(
  adapters: AdapterDescription[],
  genericPatterns: string[],
  options: { color?: boolean } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  lines.push(b(`${adapters.length} agent tool adapter(s)`));
  lines.push("");

  for (const a of adapters) {
    const suffix = a.isGeneric ? d("  (fallback — used when no tool matches)") : "";
    lines.push(`${b(a.tool)} ${d(`— ${a.displayName}`)}${suffix}`);

    const binaries = a.binaries.length > 0 ? a.binaries.join(", ") : d("(none — never auto-inferred; pass --tool)");
    lines.push(`  binaries:  ${binaries}`);

    const patterns =
      a.extraPatterns.length > 0 ? a.extraPatterns.join(", ") : d("(none — uses the generic patterns below)");
    lines.push(`  patterns:  ${patterns}`);
    lines.push("");
  }

  lines.push(b("generic patterns") + d(" (every tool falls back to these):"));
  lines.push(`  ${genericPatterns.join(", ")}`);

  return lines.join("\n").trimEnd();
}

/**
 * Machine-readable form of `agentrelay tools`: the adapter descriptions plus the
 * shared generic pattern names. Pure — the caller supplies everything.
 */
export function renderToolsJson(payload: { adapters: AdapterDescription[]; genericPatterns: string[] }): string {
  return JSON.stringify(payload, null, 2);
}
