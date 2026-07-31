// Rendering for `agentrelay overdue` — a diagnostic view of jobs the relay
// should already have acted on but hasn't. Where `next`/`upcoming` look
// forward ("what resumes, and when"), `overdue` looks at what is already late:
// jobs parked past their reset (the daemon should have resumed them) and jobs
// stuck mid-resume (a daemon that died between park and finish). An empty
// report is the healthy case. Kept as pure functions, separate from the
// commander wiring, so the output is testable without a TTY or a clock.

import type { OverdueReport } from "@agentrelay/core";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

/** Shown when nothing is overdue — the relay is keeping up (or is empty). */
export const NO_OVERDUE_MESSAGE = "No overdue jobs — the relay is keeping up.";

/** One-line hint appended under a non-empty report to point at the likely cause. */
export const OVERDUE_HINT =
  "Overdue jobs usually mean the daemon is stopped or stalled. Start it with `agentrelay daemon`.";

/**
 * Render an elapsed span (ms, assumed non-negative) as a compact "2d 3h" /
 * "4h 12m" / "7m" / "45s" string — the mirror of `status`'s countdown, for
 * time that has already passed rather than time remaining.
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);
  if (days > 0) return `${days}d ${hours}h`;
  if (totalHours > 0) return `${totalHours}h ${minutes}m`;
  return `${totalMinutes}m`;
}

/**
 * Human-friendly table for the overdue report: one row per late job (kind,
 * short id, project, how long it's been overdue, the timestamp it's measured
 * against), a header, and a footer summarizing the two kinds plus the
 * thresholds in effect. Pure: no ambient clock. `color` gates ANSI codes (TTY
 * only); a `scopeNote` is echoed once at the top when a filter is active.
 */
export function renderOverdue(report: OverdueReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const warn = (s: string): string => (color ? `${RED}${s}${RESET}` : s);
  const ok = (s: string): string => (color ? `${GREEN}${s}${RESET}` : s);

  const scopeLine = options.scopeNote ? d(`[scope: ${options.scopeNote}]`) : "";

  if (report.entries.length === 0) {
    const msg = ok(NO_OVERDUE_MESSAGE);
    return scopeLine ? `${scopeLine}\n${msg}` : msg;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  if (scopeLine) lines.push(scopeLine);
  lines.push(b(`${pad("KIND", 8)}  ${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("OVERDUE BY", 11)}  SINCE`));

  for (const entry of report.entries) {
    const kind = pad(entry.kind, 8);
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const overdue = pad(formatElapsed(entry.overdueByMs), 11);
    lines.push(`${warn(kind)}  ${b(id)}  ${project}  ${warn(overdue)}  ${d(entry.referenceAt)}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
  lines.push(d(OVERDUE_HINT));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/monitoring/jq): the resolved
 * store path, a generation timestamp, the optional active scope, and the full
 * report — entries plus the honest counts and thresholds. Pure: `generatedAt`
 * is injected, never read from an ambient clock here.
 */
export function renderOverdueJson(input: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  report: OverdueReport;
}): string {
  return JSON.stringify(input, null, 2);
}

function footer(report: OverdueReport): string {
  const jobWord = report.total === 1 ? "job" : "jobs";
  const parts = [`${report.total} overdue ${jobWord}`];
  if (report.waitingCount > 0) parts.push(`${report.waitingCount} waiting`);
  if (report.resumingCount > 0) parts.push(`${report.resumingCount} stuck resuming`);
  parts.push(`grace ${formatElapsed(report.graceMs)} · stale ${formatElapsed(report.staleMs)}`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
