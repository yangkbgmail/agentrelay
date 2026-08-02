// Rendering for `agentrelay recent` — the backward-looking companion to
// `upcoming` and `overdue`. Where `upcoming` shows the forward runway (jobs
// waiting to resume) and `overdue` the resumes the relay fell behind on,
// `recent` answers the opposite, reassuring question: "what did the relay just
// finish?" — the last N jobs to reach a terminal state, newest first, with how
// long ago each resolved and how long it took. Pure functions (separate from
// the commander wiring) so the output is testable without a TTY or a clock.

import type { RecentReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const OUTCOME_COLOR: Record<string, string> = {
  completed: GREEN,
  failed: RED,
  cancelled: YELLOW,
};

/** Shown when the store holds no terminal jobs yet — nothing has resolved. */
export const NO_RECENT_MESSAGE = "No resolved jobs yet — nothing has finished.";

/**
 * Human-friendly multi-line table for the recent report: one row per resolved
 * job (short id, project, colored outcome, how long ago it resolved, how long
 * it took), a header, and a footer summarizing the outcome tally and how many
 * are hidden by `--limit`/`--within`. Reuses `formatDurationMs` so "2h 5m"/
 * "3d 4h" match the `stats`/`overdue` output. Pure: no ambient clock (the ages
 * come precomputed in the report).
 */
export function renderRecent(report: RecentReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const outcome = (s: string): string => (color && OUTCOME_COLOR[s] ? `${OUTCOME_COLOR[s]}${s}${RESET}` : s);

  if (report.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    const win = report.withinMs !== null ? ` ${d(`(within ${formatDurationMs(report.withinMs)})`)}` : "";
    return NO_RECENT_MESSAGE + note + win;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(b(`${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("OUTCOME", 9)}  ${pad("RESOLVED", 12)}  TOOK`));

  for (const entry of report.entries) {
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const out = padVisible(outcome(entry.job.status), entry.job.status, 9);
    const resolved = pad(`${formatDurationMs(entry.ageMs)} ago`, 12);
    const took = entry.resolutionMs !== null ? formatDurationMs(entry.resolutionMs) : "-";
    lines.push(`${b(id)}  ${project}  ${out}  ${d(resolved)}  ${took}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report —
 * entries plus the honest totals (`totalTerminal`/`hidden`/`byOutcome`) and the
 * `withinMs` window applied.
 */
export function renderRecentJson(input: {
  storePath: string;
  generatedAt?: string;
  scope?: Record<string, unknown>;
  report: RecentReport;
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

function footer(report: RecentReport): string {
  const { completed, failed, cancelled } = report.byOutcome;
  const jobWord = report.totalTerminal === 1 ? "job" : "jobs";
  const parts = [`${report.totalTerminal} resolved ${jobWord}`];
  parts.push(`${completed} completed · ${failed} failed · ${cancelled} cancelled`);
  if (report.withinMs !== null) parts.push(`within ${formatDurationMs(report.withinMs)}`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Pad a possibly-colored cell to `width` columns using the *visible* text
 * length (`plain`), so ANSI escape codes don't throw off column alignment.
 */
function padVisible(rendered: string, plain: string, width: number): string {
  return plain.length >= width ? rendered : rendered + " ".repeat(width - plain.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
