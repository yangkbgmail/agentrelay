// Rendering for `agentrelay overdue` — the diagnostic mirror of `upcoming`.
// While `upcoming` shows the forward runway (jobs waiting to resume) and `next`
// the single most-imminent one, `overdue` surfaces the jobs that came due in
// the *past* but are still parked: the tell-tale sign the resume loop
// (daemon/tick) is down or the agent binary can't spawn. A healthy relay keeps
// this list empty. Kept as pure functions (separate from the commander wiring)
// so the output is testable without a TTY, a clock, or a spawned process.

import type { OverdueReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no waiting job is past due — the relay is keeping up (or idle). */
export const NO_OVERDUE_MESSAGE = "No overdue jobs — the relay is keeping up.";

/**
 * Human-friendly multi-line table for the overdue report: one row per stuck
 * job (short id, project, how long it has been overdue, its reset time), a
 * header, and a footer summarizing totals and how many are hidden by a
 * `--limit`. Reuses `formatDurationMs` so "2h 5m"/"3d 4h" match the `stats`
 * output. Pure: no ambient clock unless `now` is omitted (used only for the
 * scope-note styling; the spans come precomputed in the report).
 */
export function renderOverdue(report: OverdueReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (report.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    const grace = report.graceMs > 0 ? ` ${d(`(grace ${formatDurationMs(report.graceMs)})`)}` : "";
    return NO_OVERDUE_MESSAGE + note + grace;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(b(`${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("OVERDUE BY", 12)}  RESET AT`));

  for (const entry of report.entries) {
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const overdue = pad(formatDurationMs(entry.overdueByMs), 12);
    lines.push(`${b(id)}  ${project}  ${overdue}  ${d(entry.job.resetAt ?? "-")}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report —
 * entries plus the honest totals (`totalOverdue`/`hidden`/`maxOverdueByMs`) and
 * the `graceMs` applied.
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

/**
 * One frame of the live `overdue --watch` view: a title/header block (matching
 * the shape of `status --watch`/`upcoming --watch`) plus the colored overdue
 * report. Separated out so the watch loop only has to clear the screen and print
 * this. The spans grow in place because the loop re-reads the store and rebuilds
 * the report against a fresh `now` each pass — the diagnostic use is to leave it
 * open and watch a stuck queue's overdue count climb (or a recovering relay
 * drain it back to the keeping-up message).
 */
export function renderOverdueWatchFrame(
  report: OverdueReport,
  storePath: string,
  intervalMs: number,
  now: number = Date.now(),
  scopeNote?: string
): string {
  const stamp = new Date(now).toISOString().replace("T", " ").slice(0, 19);
  const title = `${BOLD}agentrelay overdue${RESET} ${DIM}(live, every ${Math.round(
    intervalMs / 1000
  )}s — Ctrl-C to exit)${RESET}`;
  const meta = `${DIM}${stamp}Z · ${storePath}${RESET}`;
  return [title, meta, "", renderOverdue(report, { color: true, scopeNote })].join("\n");
}

function footer(report: OverdueReport): string {
  const jobWord = report.totalOverdue === 1 ? "job" : "jobs";
  const parts = [`${report.totalOverdue} ${jobWord} overdue`];
  parts.push(`worst ${formatDurationMs(report.maxOverdueByMs)}`);
  if (report.graceMs > 0) parts.push(`grace ${formatDurationMs(report.graceMs)}`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return `${parts.join(" · ")}\nIf this list persists, check the resume loop: \`agentrelay health\` / \`agentrelay doctor\`.`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
