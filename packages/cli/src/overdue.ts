// Rendering for `agentrelay overdue` — the backlog of resumes the relay has
// fallen behind on: `waiting_for_reset` jobs whose reset time passed more than
// the grace period ago, ranked most-overdue first. Where `upcoming` looks
// forward ("what resumes next?"), `overdue` looks backward ("what should have
// resumed already but hasn't?") — the per-job complement to `health`'s
// heartbeat probe. A short, stable list is normal; a growing one, or a worst
// lag that keeps climbing, means the resume loop is stalled. Kept as pure
// functions (separate from the commander wiring) so the output is testable
// without a TTY, a clock, or a spawned process.

import type { OverdueReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no waiting job is overdue beyond the grace period (the healthy case). */
export const NO_OVERDUE_MESSAGE = "No overdue resumes — nothing is waiting past its reset time.";

/**
 * Human-friendly multi-line table for the overdue report: one row per overdue
 * job (rank, short id, project, how long overdue, absolute reset time), a
 * header, and a footer summarizing the count, the worst lag, and how many are
 * hidden by a `--limit`. Reuses `formatDurationMs` so "4h 12m"/"45m 30s" match
 * the `stats` output exactly. Pure: no ambient clock and no I/O.
 */
export function renderOverdue(report: OverdueReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (report.entries.length === 0) {
    const graceNote = report.graceMs > 0 ? ` ${d(`[grace: ${formatDurationMs(report.graceMs)}]`)}` : "";
    const scopeNote = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    return NO_OVERDUE_MESSAGE + graceNote + scopeNote;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
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
 * generation timestamp, the optional active scope, and the full report —
 * entries plus the honest totals (`totalOverdue`/`hidden`/`worstOverdueMs`) and
 * the `graceMs` that was applied.
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
  const jobWord = report.totalOverdue === 1 ? "job" : "jobs";
  const parts = [`${report.totalOverdue} ${jobWord} overdue`];
  if (report.worstOverdueMs > 0) parts.push(`worst ${formatDurationMs(report.worstOverdueMs)} behind`);
  if (report.graceMs > 0) parts.push(`grace ${formatDurationMs(report.graceMs)}`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
