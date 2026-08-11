// Rendering for `agentrelay stale` — the diagnostic complement of `overdue`.
// While `overdue` surfaces *waiting* jobs whose reset passed but that never
// resumed, `stale` surfaces jobs wedged in a non-terminal, non-waiting state
// (`resuming`/`queued`) — the tell-tale sign a daemon died mid-resume and left
// an orphan the scheduler will never pick up again. A healthy relay keeps this
// list empty. Kept as pure functions (separate from the commander wiring) so
// the output is testable without a TTY, a clock, or a spawned process.

import type { StaleReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when nothing is wedged — every job is terminal, waiting, or fresh. */
export const NO_STALE_MESSAGE = "No stale jobs — nothing is wedged mid-resume.";

/**
 * Human-friendly multi-line table for the stale report: one row per wedged job
 * (short id, project, status, how long it has sat unchanged), a header, and a
 * footer summarizing totals, the per-status breakdown, and how many are hidden
 * by a `--limit`. Reuses `formatDurationMs` so "2h 5m"/"3d 4h" match the other
 * commands. Pure: no ambient clock (the spans come precomputed in the report).
 */
export function renderStale(report: StaleReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (report.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    const grace = report.graceMs > 0 ? ` ${d(`(grace ${formatDurationMs(report.graceMs)})`)}` : "";
    return NO_STALE_MESSAGE + note + grace;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(b(`${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("STATUS", 10)}  STALE FOR`));

  for (const entry of report.entries) {
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const status = pad(entry.job.status, 10);
    const stale = formatDurationMs(entry.staleForMs);
    lines.push(`${b(id)}  ${project}  ${status}  ${d(stale)}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
  return lines.join("\n");
}

/**
 * One frame of the live `stale --watch` view: a title/header block (matching
 * the shape of `overdue --watch`) plus the colored report. Separated out so the
 * watch loop only has to clear the screen and print this. The stale spans grow
 * in place because the loop re-reads the store and rebuilds the report with a
 * fresh `now` each pass.
 */
export function renderStaleWatchFrame(
  report: StaleReport,
  storePath: string,
  intervalMs: number,
  now: number = Date.now(),
  scopeNote?: string
): string {
  const stamp = new Date(now).toISOString().replace("T", " ").slice(0, 19);
  const title = `${BOLD}agentrelay stale${RESET} ${DIM}(live, every ${Math.round(
    intervalMs / 1000
  )}s — Ctrl-C to exit)${RESET}`;
  const meta = `${DIM}${stamp}Z · ${storePath}${RESET}`;
  return [title, meta, "", renderStale(report, { color: true, scopeNote })].join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report —
 * entries plus the honest totals (`totalStale`/`hidden`/`maxStaleForMs`/
 * `byStatus`) and the `graceMs` applied.
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
  parts.push(`worst ${formatDurationMs(report.maxStaleForMs)}`);
  const breakdown = Object.keys(report.byStatus)
    .sort()
    .map((s) => `${report.byStatus[s]} ${s}`)
    .join(", ");
  if (breakdown) parts.push(breakdown);
  if (report.graceMs > 0) parts.push(`grace ${formatDurationMs(report.graceMs)}`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return (
    `${parts.join(" · ")}\n` +
    "A wedged job won't self-heal. Drop it with `agentrelay cancel <id>` (works on any\n" +
    "wedged job); a `queued` one can instead be requeued with `agentrelay retry <id>`.\n" +
    "Then check the resume loop with `agentrelay health` / `agentrelay doctor`."
  );
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
