// Rendering for `agentrelay recent` — a backward-looking feed of the jobs the
// relay has already resolved, most recently finished first, each showing how
// long the relay watched it and how long ago it wrapped up. Where `upcoming`
// shows the runway ahead (what resumes next), `recent` answers "what did the
// relay just finish while I was away?" — the past corner of the timeline
// family. Kept as pure functions (separate from the commander wiring) so the
// output is testable without a TTY, a clock, or a spawned process.

import type { JobStatus, RecentReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Per-status ANSI color, mirroring the `status` table's palette so outcomes read the same everywhere. */
const STATUS_COLOR: Partial<Record<JobStatus, string>> = {
  completed: "\x1b[32m", // green
  failed: "\x1b[31m", // red
  cancelled: "\x1b[33m", // yellow
};

/** Shown when no job has finished yet (empty queue or only active jobs). */
export const NO_RECENT_MESSAGE = "No finished jobs yet.";

/**
 * Human-friendly table for the recent-activity feed: one row per finished job
 * (position, short id, project, colored status, how long it took, how long ago
 * it finished), a header, and a footer summarizing totals, the average
 * resolution time, and how many rows are hidden by a `--limit`. Reuses
 * `formatDurationMs` so "4h 12m"/"45m 30s" match the `stats` output exactly.
 * Pure: no ambient clock unless `now` is omitted.
 */
export function renderRecent(report: RecentReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const colorStatus = (status: JobStatus): string =>
    color && STATUS_COLOR[status] ? `${STATUS_COLOR[status]}${status}${RESET}` : status;

  if (report.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    return NO_RECENT_MESSAGE + note;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const statusWidth = Math.max(9, ...report.entries.map((e) => e.job.status.length));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(
    b(
      `${pad("#", 3)}  ${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("STATUS", statusWidth)}  ${pad(
        "TOOK",
        10
      )}  FINISHED`
    )
  );

  for (const entry of report.entries) {
    const pos = pad(String(entry.position), 3);
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const status = padVisible(colorStatus(entry.job.status), entry.job.status.length, statusWidth);
    const took = pad(entry.resolutionMs === null ? "-" : formatDurationMs(entry.resolutionMs), 10);
    const ago = `${formatDurationMs(entry.finishedAgoMs)} ago`;
    lines.push(`${pos}  ${b(id)}  ${project}  ${status}  ${took}  ${d(ago)}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report —
 * entries plus the honest totals (`totalResolved`/`hidden`/`avgResolutionMs`).
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
  const jobWord = report.totalResolved === 1 ? "job" : "jobs";
  const parts = [`${report.totalResolved} ${jobWord} resolved`];
  if (report.avgResolutionMs !== null) parts.push(`avg took ${formatDurationMs(report.avgResolutionMs)}`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Pad a cell to `width` counting only its visible length, so ANSI color codes
 * (which have zero display width) don't throw off column alignment.
 */
function padVisible(s: string, visibleLen: number, width: number): string {
  return visibleLen >= width ? s : s + " ".repeat(width - visibleLen);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
