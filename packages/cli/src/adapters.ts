// Rendering helpers for `agentrelay adapters` — a human-readable listing of the
// registered agent adapters (which AI CLI tools AgentRelay understands, which
// binary names auto-infer each one, and which tool-specific rate-limit patterns
// each contributes). Users passing `--tool` to `run`/`parse`, or relying on
// argv[0] inference, otherwise have no way to discover what's supported. Kept as
// pure functions here, separate from the commander wiring in cli.ts, so the
// exact output is unit-testable without any I/O.

import type { AdapterInfo } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Renders the adapter list as a multi-line block: a header, then one stanza per
 * adapter (tool id + display name, the binaries that auto-infer it, and any
 * tool-specific parser patterns). Pure: no I/O, no clock. `color` gates ANSI
 * codes (TTY only).
 */
export function renderAdapters(adapters: AdapterInfo[], options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  lines.push(b(`${adapters.length} agent adapter(s) — pass one to \`--tool\`, or let argv[0] auto-infer it`));
  lines.push("");

  for (const a of adapters) {
    const heading = `${a.tool}${a.isDefault ? d("  (default fallback)") : ""}`;
    lines.push(`  ${b(heading)}  ${d(a.displayName)}`);

    const infers =
      a.binaries.length > 0 ? a.binaries.map((bin) => `\`${bin}\``).join(", ") : d("(none — explicit --tool only)");
    lines.push(`    infers from : ${infers}`);

    const patterns = a.extraPatterns.length > 0 ? a.extraPatterns.join(", ") : d("(generic parser only)");
    lines.push(`    patterns    : ${patterns}`);
    lines.push("");
  }

  // Drop the trailing blank line for a tidy block.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay adapters`: a small envelope carrying the
 * full adapter list. Pure — no ambient state read here.
 */
export function renderAdaptersJson(adapters: AdapterInfo[]): string {
  return JSON.stringify({ adapters }, null, 2);
}
