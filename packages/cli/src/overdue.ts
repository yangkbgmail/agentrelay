// Rendering for `agentrelay overdue` — a diagnostic view of jobs the relay was
// supposed to resume but hasn't: every `waiting_for_reset` job whose reset time
// has already passed, sorted longest-stuck first, each showing how late it is.
// Where `upcoming` is the forward-looking runway (what resumes next and when),
// `overdue` is the rear-view mirror: in a healthy relay it is empty or
// transient (a scheduler tick clears each within one poll interval), so a
// non-empty, growing, or long-latency result is the clearest per-job signal
// that the resume loop is stalled or dead — the exact failure `health`/`doctor`
// flag at the loop level, but here broken down to which jobs and for how long.
// Kept as pure functions (separate from the commander wiring) so the output is
// testable without a TTY, a clock, or a spawned process.

import type { OverdueReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Shown when no waiting job is past its reset time (the healthy case). */
export const NO_OVERDUE_MESSAGE = "No overdue jobs — the relay is on schedule.";

/**
 * Human-friendly multi-line table for the overdue report: one row per past-due
 * job (position, short id, project, how long overdue, the reset time it blew
 * past), a header, and a footer summarizing the total and the worst offender's
 * lateness. Reuses `formatDurationMs` so "4h 12m"/"3d 2h"/"45m 30s" match the
 * `stats` output exactly. Pure: no ambient clock unless `now` is omitted.
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
    const overdueBy = pad(formatDurationMs(entry.overdueByMs), 12);
    lines.push(`${pos}  ${b(id)}  ${project}  ${warn(overdueBy)}  ${d(entry.job.resetAt ?? "-")}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
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
  if (report.maxOverdueByMs > 0) parts.push(`worst ${formatDurationMs(report.maxOverdueByMs)} late`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
