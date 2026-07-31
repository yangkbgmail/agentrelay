// Rendering for `agentrelay overdue` — the backlog of jobs that should already
// have resumed but haven't. Where `upcoming` shows the forward runway (what
// resumes next and when), `overdue` isolates the jobs whose `resetAt` is
// already in the past while they sit in `waiting_for_reset`: the exact silent
// failure the relay exists to prevent. A non-empty list almost always means the
// daemon/tick isn't running (see `agentrelay health`/`doctor`). Kept as pure
// functions (separate from the commander wiring) so the output is testable
// without a TTY, a clock, or a spawned process.

import type { OverdueReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Shown when no job is overdue — the healthy state. */
export const NO_OVERDUE_MESSAGE = "No overdue jobs — every waiting job's reset is still in the future.";

/**
 * Human-friendly table for the overdue backlog: one row per stuck job (rank,
 * short id, project, how long overdue, absolute reset time), a header, and a
 * footer summarizing totals plus a hint that a stalled resume loop is the usual
 * cause. Reuses `formatDurationMs` so "3h 12m"/"2d 4h" match `stats`/`show`
 * exactly. Pure: no ambient clock unless `now` is omitted.
 */
export function renderOverdue(report: OverdueReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const warn = (s: string): string => (color ? `${YELLOW}${s}${RESET}` : s);

  if (report.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    const grace = report.graceMs > 0 ? ` ${d(`(grace ${formatDurationMs(report.graceMs)})`)}` : "";
    return NO_OVERDUE_MESSAGE + grace + note;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  if (report.graceMs > 0) lines.push(d(`grace: ${formatDurationMs(report.graceMs)}`));
  lines.push(b(`${pad("#", 3)}  ${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("OVERDUE BY", 12)}  RESET AT`));

  for (const entry of report.entries) {
    const rank = pad(String(entry.position), 3);
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const overdue = pad(formatDurationMs(entry.overdueMs), 12);
    lines.push(`${rank}  ${b(id)}  ${project}  ${warn(overdue)}  ${d(entry.job.resetAt ?? "-")}`);
  }

  lines.push("");
  lines.push(warn(footer(report)));
  lines.push(
    d("These jobs' resets have passed but nothing resumed them — check `agentrelay health` (is the daemon running?).")
  );
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq/monitoring). Carries the store
 * path, a generation timestamp, the optional active scope, and the full report
 * — entries plus the honest totals (`totalOverdue`/`hidden`/`worstOverdueMs`).
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
  if (report.worstOverdueMs !== null) parts.push(`worst ${formatDurationMs(report.worstOverdueMs)} late`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
