// Rendering helpers for `agentrelay adapters` — a discovery listing of the
// registered agent adapters: which `--tool` ids are valid, which binaries
// auto-infer to each tool, and what rate-limit patterns each contributes on top
// of the shared generic vocabulary. Kept as pure functions here, separate from
// the commander wiring in cli.ts, so the exact output is unit-testable without
// touching a store or a clock (this command reads only static config).

import type { AdapterDescription } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Renders the adapter registry as a multi-line block: a header, then one stanza
 * per adapter (tool id, display name, the binaries that auto-infer it, and its
 * tool-specific patterns), followed by the shared generic patterns every adapter
 * falls back to. Pure: no I/O, no clock. `color` gates ANSI codes (TTY only).
 */
export function renderAdapters(
  adapters: AdapterDescription[],
  genericPatterns: readonly string[],
  options: { color?: boolean } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  lines.push(b(`${adapters.length} adapter(s)`) + d(" (values accepted by --tool)"));

  for (const a of adapters) {
    lines.push("");
    const defaultTag = a.isDefault ? d("  (default)") : "";
    lines.push(`  ${b(a.tool)}${defaultTag}  ${d(`— ${a.displayName}`)}`);
    const binaries = a.binaries.length > 0 ? a.binaries.join(", ") : d("(inferred from --tool only)");
    lines.push(`    ${d("binaries:")} ${binaries}`);
    const patterns = a.extraPatterns.length > 0 ? a.extraPatterns.join(", ") : d("(generic patterns only)");
    lines.push(`    ${d("patterns:")} ${patterns}`);
  }

  lines.push("");
  lines.push(d(`generic patterns (shared by all): ${genericPatterns.join(", ")}`));

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay adapters`, mirroring the discovery
 * envelope used elsewhere: when it was generated, the adapter descriptions, and
 * the shared generic pattern names. Pure: `generatedAt` is injected, never read
 * from an ambient clock here.
 */
export function renderAdaptersJson(payload: {
  generatedAt: string;
  adapters: AdapterDescription[];
  genericPatterns: readonly string[];
}): string {
  return JSON.stringify(payload, null, 2);
}
