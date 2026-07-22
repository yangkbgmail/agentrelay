// Rendering for `agentrelay tools` — a discoverability diagnostic that shows the
// supported agent adapters (the valid `--tool` values), the binaries each
// recognizes, the tool-specific rate-limit patterns each contributes, and how
// many stored jobs currently run under each. Pure functions (no I/O, no clock)
// so the exact output is testable; the commander wiring in cli.ts does the
// store read.

import type { ToolReport } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function paint(code: string, cell: string, color: boolean): string {
  return color ? `${code}${cell}${RESET}` : cell;
}

/**
 * Render the tools report as a human-readable block. Pure: `color` gates ANSI
 * codes (TTY only), no other ambient input.
 */
export function renderToolsReport(report: ToolReport, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const registered = report.tools.filter((t) => t.adapter !== null).length;

  const lines: string[] = [paint(BOLD, `Supported agent tools (${registered})`, color), ""];

  for (const usage of report.tools) {
    if (usage.adapter) {
      const { tool, displayName, binaries, patternNames } = usage.adapter;
      lines.push(`  ${paint(CYAN, tool, color)}  ${paint(DIM, displayName, color)}`);
      const binaryText = binaries.length > 0 ? binaries.join(", ") : "(fallback — matched when no other tool fits)";
      lines.push(`    ${paint(BOLD, "binaries:", color)} ${binaryText}`);
      const patternText =
        patternNames.length > 0 ? `${patternNames.join(", ")} ${paint(DIM, "(+ generic)", color)}` : "generic only";
      lines.push(`    ${paint(BOLD, "patterns:", color)} ${patternText}`);
      lines.push(`    ${paint(BOLD, "jobs:", color)}     ${usage.jobCount}`);
    } else {
      // A tool string present in the store but not backed by a registered
      // adapter (e.g. written by a newer AgentRelay). Surface it, don't hide it.
      lines.push(`  ${paint(CYAN, usage.tool, color)}  ${paint(DIM, "(unregistered — present in store)", color)}`);
      lines.push(`    ${paint(BOLD, "jobs:", color)}     ${usage.jobCount}`);
    }
    lines.push("");
  }

  lines.push(
    paint(
      DIM,
      `Pass --tool <id> to run/parse/status/stats/export. ${report.totalJobs} job(s) tracked in the store.`,
      color
    )
  );
  return lines.join("\n");
}

/**
 * Render the tools report as JSON (machine-readable, for scripts/jq). Pure
 * aside from `generatedAt` defaulting to now when omitted.
 */
export function renderToolsReportJson(
  report: ToolReport,
  storePath: string,
  options: { generatedAt?: string } = {}
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  return JSON.stringify({ storePath, generatedAt, ...report }, null, 2);
}
