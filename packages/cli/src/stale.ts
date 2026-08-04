// Rendering for `agentrelay stale` — the diagnostic mirror of `overdue`.
// Where `overdue` surfaces jobs that should have *started* resuming but didn't
// (still `waiting_for_reset` past their reset time), `stale` surfaces the
// opposite failure mode: jobs that *did* start resuming (`resuming`) but never
// reached a terminal state — the tell-tale of a resume that crashed or a child
// process that hung. A healthy relay drains `resuming` jobs within
// seconds/minutes and keeps this list empty. Kept as pure functions (separate
// from the commander wiring) so the output is testable without a TTY, a clock,
// or a spawned process.

import type { StaleReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no resuming job is stuck — the relay is draining resumes cleanly. */
export const NO_STALE_MESSAGE = "No stale jobs — resumes are completing cleanly.";

/**
 * Human-friendly multi-line table for the stale report: one row per stuck job
 * (short id, project, how long it has been stuck in `resuming`, when it entered
 * that state), a header, and a footer summarizing totals and how many are hidden
 * by a `--limit`. Reuses `formatDurationMs` so "2h 5m"/"3d 4h" match the `stats`
 * and `overdue` output.
 */
export function renderStale(report: StaleReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (report.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    const threshold = report.thresholdMs > 0 ? ` ${d(`(threshold ${formatDurationMs(report.thresholdMs)})`)}` : "";
    return NO_STALE_MESSAGE + note + threshold;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(b(`${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("STUCK FOR", 12)}  SINCE`));

  for (const entry of report.entries) {
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const stuck = pad(formatDurationMs(entry.stuckForMs), 12);
    lines.push(`${b(id)}  ${project}  ${stuck}  ${d(entry.job.updatedAt)}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report — entries
 * plus the honest totals (`totalStale`/`hidden`/`maxStuckForMs`) and the
 * `thresholdMs` applied.
 */
export function renderStaleJson(input: {
  storePath: string;
  generatedAt?: string;
  scope?: Record<string, unknown>;
  report: StaleReport;
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

function footer(report: StaleReport): string {
  const jobWord = report.totalStale === 1 ? "job" : "jobs";
  const parts = [`${report.totalStale} ${jobWord} stale`];
  parts.push(`worst ${formatDurationMs(report.maxStuckForMs)}`);
  if (report.thresholdMs > 0) parts.push(`threshold ${formatDurationMs(report.thresholdMs)}`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return (
    `${parts.join(" · ")}\n` +
    "A resume started but never finished — the daemon may have crashed mid-run.\n" +
    "Check `agentrelay health` / `agentrelay doctor`, then `agentrelay retry <id>` to re-queue."
  );
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
