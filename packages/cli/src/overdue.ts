// Rendering for `agentrelay overdue` — a backward-looking diagnostic: the jobs
// whose reset time came and went but that nothing ever resumed. Where `upcoming`
// shows the forward runway (what resumes next and when) and `next` surfaces the
// single most imminent resume, `overdue` answers "is the relay actually keeping
// up?": a non-empty report means jobs are stuck past due, the job-centric signal
// that the resume loop (daemon/tick) isn't running. Kept as pure functions
// (separate from the commander wiring) so the output is testable without a TTY,
// a clock, or a spawned process.

import type { OverdueReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** Shown when no waiting job has slipped past its reset + grace window. */
export const NO_OVERDUE_MESSAGE = "No overdue jobs — the relay is keeping up.";

/**
 * Human-friendly multi-line table for the overdue report: one row per stuck job
 * (position, short id, project, how long overdue, absolute reset time), a
 * header, and a footer summarizing totals, how many are hidden by a `--limit`,
 * and the grace window used. Reuses `formatDurationMs` so "45m 30s"/"2h 5m"
 * match the `stats` output exactly. Pure: no ambient clock.
 */
export function renderOverdue(report: OverdueReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const r = (s: string): string => (color ? `${RED}${s}${RESET}` : s);

  if (report.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    return NO_OVERDUE_MESSAGE + note;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(b(`${pad("#", 3)}  ${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("OVERDUE BY", 12)}  RESET AT`));

  for (const entry of report.entries) {
    const pos = pad(String(entry.position), 3);
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const overdueBy = pad(formatDurationMs(entry.overdueByMs), 12);
    lines.push(`${pos}  ${b(id)}  ${project}  ${r(overdueBy)}  ${d(entry.job.resetAt ?? "-")}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report —
 * entries plus honest totals (`totalOverdue`/`hidden`) and the `graceMs` used.
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
  const parts = [`${report.totalOverdue} overdue ${jobWord}`, `grace ${formatDurationMs(report.graceMs)}`];
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
