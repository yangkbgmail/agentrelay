// Rendering for `agentrelay overdue` — a diagnostic listing of jobs whose reset
// time has already passed but that are still waiting to resume. Where `upcoming`
// looks forward ("what resumes next, and when?"), `overdue` looks at what should
// already have resumed: a long overdue tail almost always means the daemon
// stopped, crashed, or was never started. Kept as pure functions (separate from
// the commander wiring) so the output is testable without a TTY or a clock.

import type { OverdueReport } from "@agentrelay/core";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Shown when no waiting job is past its reset time (a healthy, current queue). */
export const NO_OVERDUE_MESSAGE = "No overdue jobs — nothing is past its reset time.";

/**
 * Format a non-negative elapsed duration (ms) as a compact "1d 2h" / "3h 4m" /
 * "5m" / "10s" string, mirroring `formatCountdown`'s granularity so overdue
 * ages read the same way as upcoming countdowns. Sub-minute ages fall back to
 * whole seconds so a just-overdue job doesn't collapse to "0m".
 */
export function formatOverdueAge(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);

  if (days > 0) return `${days}d ${hours}h`;
  if (totalHours > 0) return `${totalHours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Human-friendly multi-line table for the overdue report: one row per stuck job
 * (position, short id, project, how long it's been overdue, absolute reset
 * time), a header, and a footer summarizing totals, the worst age, and how many
 * are hidden by a `--limit`. Pure: no ambient clock is consulted.
 */
export function renderOverdue(report: OverdueReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const warn = (s: string): string => (color ? `${YELLOW}${s}${RESET}` : s);

  if (report.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    const grace = report.graceMs > 0 ? ` ${d(`[grace: ${formatOverdueAge(report.graceMs)}]`)}` : "";
    return NO_OVERDUE_MESSAGE + grace + note;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  const scopeBits: string[] = [];
  if (options.scopeNote) scopeBits.push(`scope: ${options.scopeNote}`);
  if (report.graceMs > 0) scopeBits.push(`grace: ${formatOverdueAge(report.graceMs)}`);
  if (scopeBits.length > 0) lines.push(d(`[${scopeBits.join("] [")}]`));

  lines.push(b(`${pad("#", 3)}  ${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("OVERDUE BY", 12)}  RESET AT`));

  for (const entry of report.entries) {
    const pos = pad(String(entry.position), 3);
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const age = pad(formatOverdueAge(entry.overdueByMs), 12);
    lines.push(`${pos}  ${b(id)}  ${project}  ${warn(age)}  ${d(entry.job.resetAt ?? "-")}`);
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
  if (report.maxOverdueByMs > 0) parts.push(`worst ${formatOverdueAge(report.maxOverdueByMs)} late`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
