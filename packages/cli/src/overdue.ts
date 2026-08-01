// Rendering for `agentrelay overdue` — the backlog of jobs the relay should
// already have resumed but hasn't: still `waiting_for_reset` past their reset
// time. Where `upcoming` shows the forward runway (what resumes next, and
// when), `overdue` isolates the past-due stragglers and how long each has been
// stuck. A non-empty list is the clearest queue-level sign the resume loop is
// dead or wedged — the silent failure this whole tool fights. Kept as pure
// functions (separate from the commander wiring) so the output is testable
// without a TTY, a clock, or a spawned process.

import type { OverdueReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Shown when no waiting job is past its reset time (the healthy case). */
export const NO_OVERDUE_MESSAGE = "No overdue jobs — every waiting job's reset is still ahead.";

/**
 * Human-friendly multi-line table for the overdue report: one row per stuck
 * job (rank, short id, project, how long overdue, the reset time it blew
 * through), a header, and a footer with the total, worst overdue span, and any
 * rows hidden by a `--limit`. Reuses `formatDurationMs` so "3h 12m"/"2d 4h"
 * match the `stats` output. Pure: no ambient clock or store access.
 */
export function renderOverdue(report: OverdueReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const warn = (s: string): string => (color ? `${YELLOW}${s}${RESET}` : s);

  if (report.entries.length === 0) {
    const parts: string[] = [];
    if (report.thresholdMs > 0) parts.push(`grace: ${formatDurationMs(report.thresholdMs)}`);
    if (options.scopeNote) parts.push(`scope: ${options.scopeNote}`);
    const note = parts.length > 0 ? ` ${d(`[${parts.join(" · ")}]`)}` : "";
    return NO_OVERDUE_MESSAGE + note;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  const headerNote: string[] = [];
  if (report.thresholdMs > 0) headerNote.push(`grace: ${formatDurationMs(report.thresholdMs)}`);
  if (options.scopeNote) headerNote.push(`scope: ${options.scopeNote}`);
  if (headerNote.length > 0) lines.push(d(`[${headerNote.join(" · ")}]`));

  lines.push(b(`${pad("#", 3)}  ${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("OVERDUE BY", 12)}  RESET AT`));

  for (const entry of report.entries) {
    const pos = pad(String(entry.position), 3);
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const overdue = pad(formatDurationMs(entry.overdueMs), 12);
    lines.push(`${pos}  ${b(id)}  ${project}  ${warn(overdue)}  ${d(entry.job.resetAt ?? "-")}`);
  }

  lines.push("");
  lines.push(warn(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq/monitoring). Carries the store
 * path, a generation timestamp, the optional active scope, and the full report
 * — entries plus the honest totals (`totalOverdue`/`hidden`/`maxOverdueMs`/
 * `thresholdMs`).
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
  const parts = [`${report.totalOverdue} overdue ${jobWord}`];
  if (report.maxOverdueMs > 0) parts.push(`worst ${formatDurationMs(report.maxOverdueMs)}`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
