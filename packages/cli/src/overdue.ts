// Rendering for `agentrelay overdue` — the jobs the relay *should* have resumed
// by now but hasn't: `waiting_for_reset` jobs whose reset time is already in the
// past. Where `upcoming` shows the runway ahead (soonest-due first), `overdue`
// surfaces what's slipped, most-overdue first, so a stalled or dead resume loop
// is obvious at a glance. Kept as pure functions (separate from the commander
// wiring) so the output is testable without a TTY, a clock, or a spawned
// process.

import type { OverdueReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when nothing is overdue (the resume loop is keeping up, or nothing is waiting). */
export const NO_OVERDUE_MESSAGE = "No overdue jobs — nothing is past its reset time.";

/**
 * Human-friendly multi-line table for the overdue report: one row per past-due
 * job (rank, short id, project, how long it's been overdue, absolute reset
 * time), a header, and a footer summarizing totals, the worst overdue span, and
 * how many are hidden by a `--limit`. Reuses `formatDurationMs` so spans match
 * the `stats`/`health` output exactly. Pure: no ambient clock beyond the report.
 */
export function renderOverdue(report: OverdueReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (report.entries.length === 0) {
    const bits: string[] = [];
    if (options.scopeNote) bits.push(`scope: ${options.scopeNote}`);
    if (report.thresholdMs > 0) bits.push(`threshold ${formatDurationMs(report.thresholdMs)}`);
    const note = bits.length > 0 ? ` ${d(`[${bits.join(", ")}]`)}` : "";
    return NO_OVERDUE_MESSAGE + note;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  const scopeBits: string[] = [];
  if (options.scopeNote) scopeBits.push(`scope: ${options.scopeNote}`);
  if (report.thresholdMs > 0) scopeBits.push(`threshold ${formatDurationMs(report.thresholdMs)}`);
  if (scopeBits.length > 0) lines.push(d(`[${scopeBits.join(", ")}]`));

  lines.push(b(`${pad("#", 3)}  ${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("OVERDUE BY", 12)}  RESET AT`));

  for (const entry of report.entries) {
    const rank = pad(String(entry.position), 3);
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const overdue = pad(formatDurationMs(entry.overdueMs), 12);
    lines.push(`${rank}  ${b(id)}  ${project}  ${overdue}  ${d(entry.job.resetAt ?? "-")}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report — entries
 * plus the honest totals (`total`/`hidden`/`maxOverdueMs`/`thresholdMs`).
 */
export function renderOverdueJson(input: {
  storePath: string;
  generatedAt?: string;
  scope?: Record<string, unknown>;
  report: OverdueReport;
}): string {
  return JSON.stringify(
    {
      storePath: input.storePath,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      scope: input.scope,
      report: input.report,
    },
    null,
    2
  );
}

function footer(report: OverdueReport): string {
  const jobWord = report.total === 1 ? "job" : "jobs";
  const parts = [`${report.total} overdue ${jobWord}`, `worst ${formatDurationMs(report.maxOverdueMs)} past due`];
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
