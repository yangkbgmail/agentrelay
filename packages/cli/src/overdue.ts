// Rendering for `agentrelay overdue` — the backward-looking counterpart to
// `next`/`upcoming`. Those look forward ("what resumes, and when?"); `overdue`
// looks back ("what should already have resumed but hasn't?"). It's the fastest
// way to spot a dead daemon (jobs long past their reset) or a wedged resume
// (jobs frozen in the `resuming` state). Kept as pure functions — separate from
// the commander wiring — so the output is testable without a TTY or a clock.

import type { OverdueReason, OverdueReport } from "@agentrelay/core";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** Shown when nothing is overdue — the healthy, boring, good case. */
export const NO_OVERDUE_MESSAGE = "Nothing overdue — the relay is on track.";

/** Short label per reason for the table's REASON column. */
const REASON_LABEL: Record<OverdueReason, string> = {
  "reset-passed": "reset passed",
  "stuck-resuming": "stuck resuming",
};

/**
 * Human-friendly "how long late" string for an elapsed millisecond span (always
 * ≥ 0). Mirrors `formatCountdown`'s unit choices so "1h 3m"/"2d 4h" read the
 * same across commands, but for time *elapsed* rather than remaining. Adds a
 * sub-minute "Ns" bucket since an overdue span can be small and fresh.
 */
export function formatLateBy(ms: number): string {
  if (ms < 1000) return "0s";
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
 * Human-friendly multi-line table for the overdue report: one row per stuck
 * job (short id, project, reason, how-late, the anchor timestamp it's late
 * against), a header, and a footer summarizing totals split by reason. When
 * `color` is on the how-late cell is red — this is a problem list, not a status
 * dump. Pure: no ambient clock is read.
 */
export function renderOverdue(report: OverdueReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const r = (s: string): string => (color ? `${RED}${s}${RESET}` : s);

  if (report.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    return NO_OVERDUE_MESSAGE + note;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(b(`${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("REASON", 14)}  ${pad("LATE BY", 10)}  SINCE`));

  for (const entry of report.entries) {
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const reason = pad(REASON_LABEL[entry.reason], 14);
    const lateBy = pad(formatLateBy(entry.lateByMs), 10);
    // The anchor a job is "late against": its reset time, or (stuck) its last update.
    const since = entry.reason === "reset-passed" ? entry.job.resetAt : entry.job.updatedAt;
    lines.push(`${b(id)}  ${project}  ${reason}  ${r(lateBy)}  ${d(since ?? "-")}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report.
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
  const jobWord = report.total === 1 ? "job" : "jobs";
  const parts = [`${report.total} ${jobWord} overdue`];
  if (report.byReason.resetPassed > 0) parts.push(`${report.byReason.resetPassed} past reset`);
  if (report.byReason.stuckResuming > 0) parts.push(`${report.byReason.stuckResuming} stuck resuming`);
  parts.push(`worst ${formatLateBy(report.worstLateByMs)} late`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
