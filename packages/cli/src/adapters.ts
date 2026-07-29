// Rendering helpers for `agentrelay adapters` — a static introspection of the
// agent-adapter registry: which tools AgentRelay knows how to wrap, which
// argv[0] binaries auto-select each one, and which rate-limit patterns each
// contributes on top of the shared generic parser. This is the *static*
// counterpart to `agentrelay patterns` (which aggregates the patterns that
// actually fired across the live queue). Pure functions here, separate from the
// commander wiring in cli.ts, so the exact output is unit-testable.

import type { AdapterRegistrySummary } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Renders the adapter registry as a multi-line block: one stanza per adapter
 * (display name, tool id, the binaries that auto-select it, and its extra
 * rate-limit patterns), followed by the generic patterns every adapter shares.
 * Pure: no I/O, no clock. `color` gates ANSI codes (TTY only).
 */
export function renderAdapters(summary: AdapterRegistrySummary, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  lines.push(b(`${summary.adapters.length} registered adapter(s)`));
  lines.push("");

  for (const a of summary.adapters) {
    const defaultTag = a.isDefault ? d("  (default)") : "";
    lines.push(`${b(a.displayName)} ${d(`[${a.tool}]`)}${defaultTag}`);

    // Which argv[0] names auto-select this adapter. The generic fallback has
    // none — it's what you get when nothing else matches.
    if (a.binaries.length > 0) {
      lines.push(`  binaries: ${a.binaries.join(", ")}`);
    } else {
      lines.push(`  binaries: ${d("(none — fallback when no tool matches)")}`);
    }

    if (a.extraPatterns.length > 0) {
      lines.push(`  extra patterns: ${a.extraPatterns.join(", ")}`);
    } else {
      lines.push(`  extra patterns: ${d("(none — uses generic patterns only)")}`);
    }
    lines.push("");
  }

  lines.push(b("Generic patterns") + d(" (shared fallback, tried after any adapter-specific ones):"));
  if (summary.genericPatterns.length > 0) {
    for (const name of summary.genericPatterns) {
      lines.push(`  ${name}`);
    }
  } else {
    lines.push(d("  (none)"));
  }

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay adapters`, mirroring the sibling
 * commands' envelope: when it was generated plus the full registry summary.
 * Pure: `generatedAt` is injected, never read from an ambient clock here.
 */
export function renderAdaptersJson(payload: { generatedAt: string; summary: AdapterRegistrySummary }): string {
  return JSON.stringify(payload, null, 2);
}
