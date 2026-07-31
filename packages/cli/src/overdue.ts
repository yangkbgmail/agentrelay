// Rendering for `agentrelay overdue` — the jobs the relay should already have
// resumed but hasn't: waiting jobs whose reset passed more than a grace window
// ago. Where `upcoming` looks forward and `next` at the single next move,
// `overdue` looks backward at what has slipped, so a non-empty result (with a
// live daemon) is a direct, store-only signal of a stalled resume loop. Kept as
// pure functions (separate from the commander wiring) so the output is testable
// without a TTY, a clock, or a spawned process.

import type { OverdueReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** Shown when no waiting job has slipped past its grace window. */
export const NO_OVERDUE_MESSAGE = "No overdue jobs — every waiting job is still within its reset window.";

/**
 * Human-friendly multi-line table for the overdue report: one row per slipped
 * job (position, short id, project, how long overdue, absolute reset time), a
 * header, and a footer summarizing totals and the grace window used. Reuses
 * `formatDurationMs` so "5m 0s"/"2h 10m"/"3d 4h" match the `stats`/`show`
 * output exactly. Pure: no ambient clock unless `now` is omitted.
 */
export function renderOverdue(report: OverdueReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const warn = (s: string): string => (color ? `${RED}${s}${RESET}` : s);

  const graceNote = `grace ${formatGrace(report.graceMs)}`;

  if (report.entries.length === 0) {
    const parts = [graceNote];
    if (options.scopeNote) parts.push(`scope: ${options.scopeNote}`);
    return `${NO_OVERDUE_MESSAGE} ${d(`[${parts.join(" · ")}]`)}`;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  const noteParts = [graceNote];
  if (options.scopeNote) noteParts.push(`scope: ${options.scopeNote}`);
  lines.push(d(`[${noteParts.join(" · ")}]`));
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
 * entries plus the honest totals (`totalOverdue`/`hidden`/`longestOverdueMs`)
 * and the `graceMs` used.
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
  parts.push(`longest ${formatDurationMs(report.longestOverdueMs)}`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return parts.join(" · ");
}

/** A readable rendering of the grace window: "0s" when zero, else formatDurationMs. */
function formatGrace(ms: number): string {
  return ms === 0 ? "0s" : formatDurationMs(ms);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
