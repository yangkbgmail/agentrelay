// Rendering for `agentrelay slowest` — the resolved jobs that cost the relay the
// most wall-clock time, longest first, each with its lifecycle span. Where
// `stats` reports aggregate resolution percentiles (avg/median/p90), `slowest`
// names the actual outlier jobs behind that tail so you can open them with
// `agentrelay show <id>`. Kept as pure functions (separate from the commander
// wiring) so the output is testable without a TTY or a spawned process.

import type { SlowestReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no job has a countable resolution span (empty queue or nothing finished yet). */
export const NO_SLOWEST_MESSAGE = "No resolved jobs to rank yet.";

/**
 * Human-friendly multi-line table: one row per resolved job (rank, short id,
 * project, status, resolution span), a header, and a footer summarizing totals
 * and how many are hidden by a `--limit`. Reuses `formatDurationMs` so spans
 * ("4h 12m", "3d 2h") match the `stats`/`show` output exactly. Pure: no I/O.
 */
export function renderSlowest(report: SlowestReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (report.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    return NO_SLOWEST_MESSAGE + note;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(b(`${pad("#", 3)}  ${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("STATUS", 9)}  RESOLUTION`));

  for (const entry of report.entries) {
    const rank = pad(String(entry.rank), 3);
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const status = pad(entry.job.status, 9);
    lines.push(`${rank}  ${b(id)}  ${project}  ${status}  ${formatDurationMs(entry.resolutionMs)}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report —
 * entries plus the honest totals (`totalResolved`/`hidden`).
 */
export function renderSlowestJson(input: {
  storePath: string;
  generatedAt?: string;
  scope?: Record<string, unknown>;
  report: SlowestReport;
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

function footer(report: SlowestReport): string {
  const jobWord = report.totalResolved === 1 ? "job" : "jobs";
  const parts = [`${report.totalResolved} resolved ${jobWord}`];
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
