// Rendering for `agentrelay overdue` — a backward-looking diagnostic listing
// the jobs whose reset time has passed but which the scheduler still hasn't
// resumed, most-overdue first. In a healthy setup a job is resumed within a
// poll interval of its reset, so this list is normally empty; rows here mean
// the resume loop is behind, stuck, or not running (pair it with `agentrelay
// health`/`doctor` to see whether a daemon is alive at all). Kept as pure
// functions (separate from the commander wiring) so the output is testable
// without a TTY, a clock, or a spawned process.

import type { OverdueReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Shown when no waiting job has slipped past its reset time. */
export const NO_OVERDUE_MESSAGE = "No jobs are overdue for resume — the relay is keeping up.";

/**
 * Human-friendly multi-line table for the overdue report: one row per stuck
 * job (rank, short id, project, how long overdue, the reset time it blew past),
 * a header, and a footer summarizing the count and worst overshoot. Reuses
 * `formatDurationMs` so "2h 5m"/"3d 1h" match the `stats`/`show` output. Pure:
 * no ambient clock unless `now` is omitted.
 */
export function renderOverdue(
  report: OverdueReport,
  options: { color?: boolean; scopeNote?: string; minOverdueNote?: string } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const warn = (s: string): string => (color ? `${YELLOW}${s}${RESET}` : s);

  const notes: string[] = [];
  if (options.scopeNote) notes.push(`scope: ${options.scopeNote}`);
  if (options.minOverdueNote) notes.push(`overdue by ≥ ${options.minOverdueNote}`);
  const noteLine = notes.length > 0 ? d(`[${notes.join(" · ")}]`) : "";

  if (report.entries.length === 0) {
    return noteLine ? `${NO_OVERDUE_MESSAGE} ${noteLine}` : NO_OVERDUE_MESSAGE;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  if (noteLine) lines.push(noteLine);
  lines.push(b(`${pad("#", 3)}  ${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("OVERDUE BY", 12)}  RESET AT`));

  for (const entry of report.entries) {
    const rank = pad(String(entry.rank), 3);
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const overdue = pad(formatDurationMs(entry.overdueByMs), 12);
    lines.push(`${rank}  ${b(id)}  ${project}  ${warn(overdue)}  ${d(entry.job.resetAt ?? "-")}`);
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
  if (report.maxOverdueByMs > 0) parts.push(`worst ${formatDurationMs(report.maxOverdueByMs)} behind`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
