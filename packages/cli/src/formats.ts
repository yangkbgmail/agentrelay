// Rendering helpers for `agentrelay formats` — a catalog of every rate-limit
// message format AgentRelay recognizes (generic parser patterns + tool-specific
// adapter patterns), each with a one-line description and a real example. This
// answers "what wordings will AgentRelay actually detect and auto-resume?" —
// the static counterpart to `parse` (test one message) and `patterns` (which
// patterns have fired across the store). Kept as pure functions here, separate
// from the commander wiring in cli.ts, so the exact output is unit-testable.

import type { PatternDoc } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

/** Shown (unusual) when a filter leaves the catalog empty. */
export const NO_FORMATS_MESSAGE = "No rate-limit formats to show.";

/**
 * Render the catalog as a human-readable block: a header, then the generic
 * patterns (in parser precedence order) and, when present, the adapter patterns
 * grouped under a tool heading. Each entry shows its name, description, and an
 * example. Pure: no I/O, no clock. `color` gates ANSI codes (TTY only).
 */
export function renderCatalog(docs: PatternDoc[], options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);
  const c = (s: string) => (color ? `${CYAN}${s}${RESET}` : s);

  if (docs.length === 0) return NO_FORMATS_MESSAGE;

  const generic = docs.filter((doc) => doc.scope === "generic");
  const adapters = docs.filter((doc) => doc.scope === "adapter");

  const lines: string[] = [];
  lines.push(b(`${docs.length} rate-limit format(s) recognized`));

  const renderEntry = (doc: PatternDoc) => {
    lines.push(`  ${c(doc.name)}`);
    lines.push(`    ${doc.description}`);
    lines.push(d(`    e.g. ${JSON.stringify(doc.example)}`));
  };

  if (generic.length > 0) {
    lines.push("");
    lines.push(b("Generic patterns") + d(" (tried in this order; first match wins)"));
    for (const doc of generic) renderEntry(doc);
  }

  if (adapters.length > 0) {
    // Group adapter entries by tool, preserving first-seen tool order.
    const byTool = new Map<string, PatternDoc[]>();
    for (const doc of adapters) {
      const key = doc.tool ?? "unknown";
      const bucket = byTool.get(key);
      if (bucket) bucket.push(doc);
      else byTool.set(key, [doc]);
    }
    for (const [tool, entries] of byTool) {
      lines.push("");
      lines.push(b(`Adapter patterns: ${tool}`) + d(" (tried before the generic ones)"));
      for (const doc of entries) renderEntry(doc);
    }
  }

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay formats`, mirroring the other command
 * JSON envelopes: an optional `tool` scope and the list of documented formats.
 * Pure.
 */
export function renderCatalogJson(payload: { tool?: string; formats: PatternDoc[] }): string {
  return JSON.stringify(payload, null, 2);
}
