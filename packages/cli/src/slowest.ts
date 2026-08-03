// Rendering for `agentrelay slowest` — the individual-job companion to `stats`.
// While `stats` reports the aggregate resolution percentiles (p50/p90/max),
// `slowest` names the concrete jobs behind that tail: the completed/failed jobs
// the relay babysat the longest, from queue to a terminal state. Useful for
// spotting a single job that spent hours (or days) cycling rate-limits and
// retries. Kept as pure functions (separate from the commander wiring) so the
// output is testable without a TTY, a clock, or a spawned process.

import type { SlowestReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no job has resolved yet — there's nothing to rank. */
export const NO_RESOLVED_MESSAGE = "No resolved jobs yet — nothing to rank by resolution time.";

/**
 * Human-friendly multi-line table for the slowest report: one row per resolved
 * job (short id, project, tool, how long it took, its terminal status), a
 * header, and a footer summarizing totals and how many are hidden by a
 * `--limit`. Reuses `formatDurationMs` so "2h 5m"/"3d 4h" match the `stats`
 * output. Pure: no ambient clock (spans come precomputed in the report).
 */
export function renderSlowest(report: SlowestReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (report.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    return NO_RESOLVED_MESSAGE + note;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const toolWidth = Math.min(12, Math.max(4, ...report.entries.map((e) => e.job.tool.length)));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(
    b(`${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("TOOL", toolWidth)}  ${pad("RESOLVED IN", 12)}  STATUS`)
  );

  for (const entry of report.entries) {
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const tool = pad(truncate(entry.job.tool, toolWidth), toolWidth);
    const took = pad(formatDurationMs(entry.resolutionMs), 12);
    lines.push(`${b(id)}  ${project}  ${tool}  ${took}  ${d(entry.job.status)}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report —
 * entries plus the honest totals (`totalResolved`/`hidden`/`maxResolutionMs`).
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
  parts.push(`slowest ${formatDurationMs(report.maxResolutionMs)}`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
