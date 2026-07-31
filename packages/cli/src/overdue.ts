// Rendering for `agentrelay overdue` — a backward-looking diagnostic listing
// the jobs whose reset time has already passed but which are still waiting to
// resume. Where `next`/`upcoming` answer "what resumes next, and when?", this
// answers "what should already be running but isn't?" — the single clearest
// view of the silent-resume-failure the relay exists to prevent (loop down,
// wedged, or pointed at a different store). Kept as pure functions (separate
// from the commander wiring) so the output is testable without a TTY, a clock,
// or a spawned process.

import type { OverdueReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Shown when no waiting job is past its reset time — the relay is on schedule. */
export const NO_OVERDUE_MESSAGE = "No overdue jobs — every waiting job is still ahead of its reset.";

/**
 * Human-friendly multi-line table for the overdue report: one row per job past
 * its reset (position, short id, project, how long overdue, a "!" marker when
 * it is past the grace window), a header, and a footer summarizing totals. A
 * concerning row (overdue beyond grace) is highlighted so a genuinely stuck
 * relay stands out from jobs that only just came due. Reuses `formatDurationMs`
 * so durations match `stats`/`health`. Pure: no ambient clock.
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
  lines.push(b(`${pad("#", 3)}  ${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("OVERDUE BY", 12)}  RESET AT`));

  for (const entry of report.entries) {
    const pos = pad(String(entry.position), 3);
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const overdueBy = pad(formatDurationMs(entry.overdueByMs), 12);
    const row = `${pos}  ${b(id)}  ${project}  ${overdueBy}  ${d(entry.job.resetAt ?? "-")}`;
    lines.push(entry.concerning ? `${warn("!")} ${row}` : `  ${row}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
  if (report.concerningCount > 0) {
    lines.push(
      warn(
        `${report.concerningCount} job(s) overdue beyond the ${formatDurationMs(report.graceMs)} grace window — ` +
          "check the resume loop with `agentrelay health` / `agentrelay doctor`."
      )
    );
  }
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report —
 * entries plus the honest totals (`overdueCount`/`concerningCount`/`hidden`).
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
  const jobWord = report.overdueCount === 1 ? "job" : "jobs";
  const parts = [`${report.overdueCount} ${jobWord} overdue`];
  if (report.concerningCount > 0) parts.push(`${report.concerningCount} past grace`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  parts.push(`${report.totalWaiting} waiting total`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
