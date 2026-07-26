// Rendering helpers for `agentrelay tools` — a fleet-level view of the agent
// adapters AgentRelay ships with: how each is recognized from a command, which
// extra rate-limit formats it understands on top of the generic parser, and how
// many jobs in the store use it. Kept as pure functions here, separate from the
// commander wiring in cli.ts, so the exact output is unit-testable without a
// store or a clock.

import type { ToolsReport } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Renders the adapter report as a multi-line block: a header listing the generic
 * pattern names every adapter shares, then one stanza per adapter (display name +
 * tool id, its binaries, any tool-specific patterns, and its job counts). Pure:
 * no I/O, no clock. `color` gates ANSI codes (TTY only); a `scopeNote` is echoed
 * once at the top when a filter narrows the job counts.
 */
export function renderTools(report: ToolsReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  lines.push(b(`${report.adapters.length} agent adapter(s) registered`) + d(` (${report.totalJobs} job(s) tracked)`));
  lines.push(
    d(
      `generic patterns (all tools): ${report.genericPatterns.length > 0 ? report.genericPatterns.join(", ") : "(none)"}`
    )
  );

  for (const adapter of report.adapters) {
    lines.push("");
    lines.push(`  ${b(adapter.displayName)} ${d(`(${adapter.tool})`)}`);
    lines.push(`    binaries:  ${adapter.binaries.length > 0 ? adapter.binaries.join(", ") : d("(fallback default)")}`);
    lines.push(
      `    patterns:  ${adapter.extraPatterns.length > 0 ? `+ ${adapter.extraPatterns.join(", ")}` : d("generic only")}`
    );
    const active = adapter.activeCount > 0 ? ` (${adapter.activeCount} active)` : "";
    lines.push(`    jobs:      ${adapter.jobCount}${d(active)}`);
  }

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay tools`, mirroring the `renderPatternsJson`
 * envelope: the resolved store path, when it was generated, the optional active
 * scope, and the full report. Pure: `generatedAt` is injected, never read from an
 * ambient clock here.
 */
export function renderToolsJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  report: ToolsReport;
}): string {
  return JSON.stringify(payload, null, 2);
}
