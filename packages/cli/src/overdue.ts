// Rendering for `agentrelay overdue` — the alarm view: every job whose reset
// time has already passed but that is still sitting in `waiting_for_reset`
// instead of resuming, longest-stuck first. Where `upcoming` looks forward
// ("what resumes next?"), `overdue` looks at what should already have happened.
// A non-empty report while the daemon is meant to be running is the loudest
// signal of the exact silent failure the relay exists to prevent: jobs that
// came due and nothing picked them up. Kept as pure functions (separate from
// the commander wiring) so the output is testable without a TTY or a clock.

import type { OverdueReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Shown when no waiting job is past its reset time (a healthy, caught-up relay). */
export const NO_OVERDUE_MESSAGE = "No overdue jobs — every waiting job's reset is still in the future.";

/**
 * Human-friendly multi-line table for the overdue report: one row per stuck
 * job (rank, short id, project, how long it's been overdue, the reset time it
 * passed), a header, and a footer summarizing totals and how many are hidden by
 * a `--limit`. Reuses `formatDurationMs` so the "overdue by" spans read the same
 * as `stats` resolution times. Pure: no ambient clock unless `now` is omitted.
 */
export function renderOverdue(report: OverdueReport, options: { color?: boolean; scopeNote?: string } = {}): string {
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
  if (report.graceMs > 0) lines.push(d(`[grace: ${formatDurationMs(report.graceMs)}]`));
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
 * Machine-readable form for `--json` (scripts/jq/monitors). Carries the store
 * path, a generation timestamp, the optional active scope, and the full report
 * — entries plus the honest totals (`totalOverdue`/`hidden`/`maxOverdueMs`).
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
