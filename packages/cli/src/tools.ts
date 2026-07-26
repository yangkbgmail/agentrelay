// Rendering helpers for `agentrelay tools` (alias `adapters`) — an introspective
// view of the agent adapters this build supports (recognized binaries + count of
// tool-specific rate-limit patterns) cross-referenced with how many jobs the
// queue actually runs under each. Pure functions, separate from the commander
// wiring in cli.ts, so the exact output is unit-testable without a store.

import type { AdapterSummary } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Shown when the store (or scoped subset) has no jobs at all — the registry is still listed. */
export const NO_JOBS_NOTE = "No jobs in the queue yet — usage counts are all zero.";

/** Shown when a `--status`/`--tool`/`--project` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter — showing the registry with zero usage.";

/**
 * Renders the adapter summary as a multi-line block: one row per registered
 * adapter (display name, tool id, job/active counts) plus its recognized
 * binaries and tool-specific pattern names, then a trailing block for any
 * unregistered tool ids found on jobs. Pure: no I/O, no clock. `color` gates
 * ANSI codes (TTY only); a `scopeNote` is echoed once at the top when active.
 */
export function renderTools(summary: AdapterSummary, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  const header =
    summary.total === 0
      ? options.scopeNote
        ? NO_SCOPE_MATCH_MESSAGE
        : NO_JOBS_NOTE
      : b(`${summary.adapters.length} adapter(s) registered`) + d(` (${summary.total} job(s) tracked)`);
  lines.push(header);
  lines.push("");

  for (const a of summary.adapters) {
    const usage =
      a.jobs === 0 ? d("0 jobs") : `${a.jobs} job(s)${a.activeJobs > 0 ? d(` (${a.activeJobs} active)`) : ""}`;
    lines.push(`  ${b(a.displayName)} ${d(`[${a.tool}]`)}  ${usage}`);
    const bins = a.binaries.length > 0 ? a.binaries.join(", ") : d("(explicit --tool only)");
    lines.push(`    binaries: ${bins}`);
    const pats =
      a.patternCount === 0
        ? d("generic parser only")
        : `${a.patternCount} tool-specific (${a.patternNames.join(", ")})`;
    lines.push(`    patterns: ${pats}`);
  }

  if (summary.unknownTools.length > 0) {
    lines.push("");
    lines.push(b("Unregistered tool ids found on jobs:"));
    for (const u of summary.unknownTools) {
      lines.push(`  ${u.tool}  ${u.jobs} job(s)`);
    }
  }

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay tools`, mirroring the `renderPatternsJson`
 * envelope: the resolved store path, when it was generated, the optional active
 * scope, and the full summary. Pure: `generatedAt` is injected, not read here.
 */
export function renderToolsJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  summary: AdapterSummary;
}): string {
  return JSON.stringify(payload, null, 2);
}
