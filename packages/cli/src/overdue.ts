// Rendering for `agentrelay overdue` — the backward-looking companion to
// `upcoming`. Where `upcoming` shows the runway ahead (jobs waiting for a future
// reset), `overdue` surfaces the failure case: jobs whose reset time has already
// passed but which are still stuck in `waiting_for_reset`. A healthy scheduler
// would have resumed these already, so a non-empty report is the clearest "the
// relay isn't resuming" signal there is — the loop is down, lagging, or pointed
// at the wrong store. Kept as pure functions (separate from the commander
// wiring) so the output is testable without a TTY, a clock, or a spawned process.

import type { OverdueReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

/** Shown when no waiting job is past due — the healthy, reassuring case. */
export const NO_OVERDUE_MESSAGE = "No overdue jobs — every waiting job's reset is still in the future.";

/**
 * Human-friendly multi-line table for the overdue report: one row per past-due
 * waiting job (rank, short id, project, how long overdue, the reset time that
 * has passed), most-overdue first. When jobs are overdue the summary line is
 * highlighted in red as a warning; the empty case is a green all-clear. Pure:
 * no ambient clock is consulted (the report already carries the computed
 * lateness).
 */
export function renderOverdue(report: OverdueReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const warn = (s: string): string => (color ? `${RED}${s}${RESET}` : s);
  const ok = (s: string): string => (color ? `${GREEN}${s}${RESET}` : s);

  if (report.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    return ok(NO_OVERDUE_MESSAGE) + note;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(b(`${pad("#", 3)}  ${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("OVERDUE BY", 12)}  RESET AT`));

  for (const entry of report.entries) {
    const rank = pad(String(entry.position), 3);
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const late = pad(formatDurationMs(entry.overdueByMs), 12);
    lines.push(`${rank}  ${b(id)}  ${project}  ${warn(late)}  ${d(entry.job.resetAt ?? "-")}`);
  }

  lines.push("");
  lines.push(warn(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/monitors). Carries the store path,
 * a generation timestamp, the optional active scope, and the full report —
 * entries plus the honest totals (`totalOverdue`/`hidden`/`maxOverdueByMs`). A
 * monitor can branch on `report.totalOverdue > 0` without parsing text.
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
  const parts = [`${report.totalOverdue} ${jobWord} overdue`, `worst ${formatDurationMs(report.maxOverdueByMs)} late`];
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return `⚠ ${parts.join(" · ")}`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
