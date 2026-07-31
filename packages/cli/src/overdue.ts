// Rendering for `agentrelay overdue` — a backward-looking diagnostic listing
// jobs whose reset time has already passed but which are still
// `waiting_for_reset`. If the resume daemon is running, this list should stay
// empty: a due job gets picked up on the next tick. A non-empty `overdue` is
// the tell-tale of a stopped/crashed/wedged daemon (or a job that will never be
// resumed). Kept as pure functions (separate from the commander wiring) so the
// output is testable without a TTY, a clock, or a spawned process.

import type { OverdueReport } from "@agentrelay/core";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Shown when nothing is overdue — the healthy case (daemon keeping up or queue empty). */
export const NO_OVERDUE_MESSAGE = "No overdue jobs — the resume loop is keeping up.";

/**
 * Format an elapsed span (ms in the past) as a compact "2d 3h" / "4h 5m" /
 * "6m" / "45s" string. Unlike `formatCountdown` (which collapses any past time
 * to "due now"), this keeps the magnitude so you can see *how long* a job has
 * been stuck.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const totalMinutes = Math.floor(total / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);
  if (days > 0) return `${days}d ${hours}h`;
  if (totalHours > 0) return `${totalHours}h ${minutes}m`;
  return `${totalMinutes}m`;
}

/**
 * Human-friendly multi-line table for the overdue report: one row per stuck
 * job (position, short id, project, how long it's been overdue, absolute reset
 * time), a header, and a footer summarizing totals plus a hint to check the
 * daemon. Pure: no ambient clock unless `now` is omitted.
 */
export function renderOverdue(
  report: OverdueReport,
  options: { now?: number; color?: boolean; scopeNote?: string } = {}
): string {
  // `now` is accepted for call-site symmetry with `renderUpcoming`, but the
  // report already carries each row's `overdueByMs` (computed at build time),
  // so rendering needs no ambient clock of its own.
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
    const elapsed = pad(formatElapsed(entry.overdueByMs), 12);
    lines.push(`${pos}  ${b(id)}  ${project}  ${warn(elapsed)}  ${d(entry.job.resetAt ?? "-")}`);
  }

  lines.push("");
  lines.push(warn(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report —
 * entries plus the honest totals (`totalOverdue`/`hidden`/`worstOverdueMs`/
 * `graceMs`).
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
  const jobWord = report.totalOverdue === 1 ? "job is" : "jobs are";
  const parts = [`${report.totalOverdue} ${jobWord} overdue`];
  parts.push(`worst ${formatElapsed(report.worstOverdueMs)} behind`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  parts.push("is the daemon running? (`agentrelay health` / `agentrelay daemon`)");
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
