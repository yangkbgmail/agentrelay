// Rendering for `agentrelay slowest` — the individual worst-resolution jobs
// behind the `stats` resolution-time aggregates. Where `stats` reports the
// distribution (avg/median/p90/p95/p99), `slowest` names the specific jobs that
// dragged the tail: the tasks the relay spent longest getting through their
// rate-limit windows. Kept as pure functions (separate from the commander
// wiring) so the output is testable without a TTY or a spawned process.

import type { SlowestReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no terminal job has a measurable resolution span yet. */
export const NO_SLOWEST_MESSAGE = "No resolved jobs yet — nothing to rank by resolution time.";

/**
 * Human-friendly table for the slowest report: one row per resolved job (short
 * id, project, tool, attempts, resolution span), a header, and a footer
 * summarizing how many resolved jobs were considered and how many are hidden by
 * a `--limit`. Reuses `formatDurationMs` so "2h 5m"/"3d 4h" match `stats`.
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
  const toolWidth = Math.max(4, ...report.entries.map((e) => e.job.tool.length));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(
    b(`${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("TOOL", toolWidth)}  ${pad("TRIES", 5)}  RESOLUTION`)
  );

  for (const entry of report.entries) {
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const tool = pad(entry.job.tool, toolWidth);
    const tries = pad(String(entry.job.attempts), 5);
    lines.push(`${b(id)}  ${project}  ${d(tool)}  ${tries}  ${formatDurationMs(entry.resolutionMs)}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report —
 * entries plus the honest totals (`totalResolved`/`hidden`/`maxResolutionMs`/
 * `totalResolutionMs`).
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
  parts.push(`worst ${formatDurationMs(report.maxResolutionMs)}`);
  if (report.totalResolved > 0) {
    const avg = Math.round(report.totalResolutionMs / report.totalResolved);
    parts.push(`avg ${formatDurationMs(avg)}`);
  }
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
