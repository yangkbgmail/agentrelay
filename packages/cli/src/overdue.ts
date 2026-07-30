// Rendering for `agentrelay overdue` — the diagnostic mirror of `upcoming`. It
// lists the jobs the relay is *late* on: `waiting_for_reset` jobs whose reset
// time has already passed but which are still waiting. A non-empty result means
// the resume loop is behind — almost always because the daemon/tick isn't
// running (see `doctor`/`health`). An empty report is the healthy state. Kept as
// pure functions (separate from the commander wiring) so the output is testable
// without a TTY, a clock, or a spawned process.

import type { OverdueReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Shown when no waiting job is past its reset time — the resume loop is keeping up. */
export const NO_OVERDUE_MESSAGE = "No overdue jobs — the resume loop is keeping up.";

/**
 * Human-friendly multi-line table for the overdue report: one row per late job
 * (position, short id, project, how long it has been overdue, absolute reset
 * time), a header, and a footer summarizing totals and how many are hidden by a
 * `--limit`. Reuses `formatDurationMs` so the "OVERDUE BY" column matches the
 * duration formatting elsewhere. Pure: no ambient clock unless `now` is omitted.
 */
export function renderOverdue(
  report: OverdueReport,
  options: { now?: number; color?: boolean; scopeNote?: string } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const warn = (s: string): string => (color ? `${YELLOW}${s}${RESET}` : s);

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
    const overdue = pad(formatDurationMs(entry.overdueByMs), 12);
    lines.push(`${pos}  ${b(id)}  ${project}  ${warn(overdue)}  ${d(entry.job.resetAt ?? "-")}`);
  }

  lines.push("");
  lines.push(warn(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report —
 * entries plus the honest totals (`totalOverdue`/`hidden`/`maxOverdueByMs`).
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
  if (report.maxOverdueByMs > 0) parts.push(`oldest ${formatDurationMs(report.maxOverdueByMs)} late`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  parts.push("resume loop may be down — check `agentrelay health`");
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
