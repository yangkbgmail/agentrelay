// Rendering for `agentrelay overdue` — the diagnostic counterpart to
// `upcoming`. Where `upcoming` shows the forward runway (what resumes next and
// when), `overdue` shows only the jobs that are already late: still
// `waiting_for_reset` even though their reset time has passed. On a live daemon
// a non-empty report is an alarm — the resume loop is stuck and jobs are
// stranded past their reset — so rows are ordered worst-first and each shows
// how long it has been waiting. Kept as pure functions (separate from the
// commander wiring) so the output is testable without a TTY, a clock, or a
// spawned process.

import type { OverdueReport } from "@agentrelay/core";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** Shown when no waiting job is past its reset — the relay is caught up. */
export const NO_OVERDUE_MESSAGE = "No overdue jobs — every waiting job is still ahead of its reset.";

/**
 * Human-friendly multi-line table for the overdue report: one row per late job
 * (position, short id, project, how overdue, absolute reset time), a header,
 * and a footer summarizing totals and how many are hidden by a `--limit`. Pure:
 * the lateness durations are precomputed in the report, so no clock is read.
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
    const overdue = pad(formatElapsed(entry.overdueByMs), 12);
    lines.push(`${pos}  ${b(id)}  ${project}  ${r(overdue)}  ${d(entry.job.resetAt ?? "-")}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report —
 * entries plus the honest totals (`totalOverdue`/`hidden`/`worstOverdueByMs`).
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
  if (report.worstOverdueByMs > 0) parts.push(`worst ${formatElapsed(report.worstOverdueByMs)} late`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return parts.join(" · ");
}

/**
 * Format a positive elapsed duration (ms) as a compact "how long ago" string,
 * mirroring `formatCountdown`'s `Nd Nh` / `Nh Nm` / `Nm` shape but for the past.
 * Sub-minute lateness rounds up to "1m" so a just-missed reset never reads as
 * "0m" (which would look like it isn't overdue at all).
 */
export function formatElapsed(ms: number): string {
  const totalMinutes = Math.max(1, Math.round(ms / 60_000));
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);

  if (days > 0) return `${days}d ${hours}h`;
  if (totalHours > 0) return `${totalHours}h ${minutes}m`;
  return `${minutes}m`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
