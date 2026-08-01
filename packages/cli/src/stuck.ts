// Rendering for `agentrelay stuck` — the in-flight mirror of `overdue`.
// While `overdue` surfaces `waiting_for_reset` jobs the resume loop should have
// started but hasn't, `stuck` surfaces jobs it *did* start — flipped to
// `resuming` — that never finished: the tell-tale of a daemon that died between
// spawning the agent command and recording the outcome. Such a job is orphaned
// (the scheduler's `listDue` only re-picks `waiting_for_reset`, and `retry`
// refuses a `resuming` job), so it stays frozen and invisible until this report
// finds it. Kept as pure functions (separate from the commander wiring) so the
// output is testable without a TTY, a clock, or a spawned process.

import type { StuckReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no job is stranded mid-resume — the relay is healthy (or idle). */
export const NO_STUCK_MESSAGE = "No stuck jobs — nothing is stranded mid-resume.";

/**
 * Human-friendly multi-line table for the stuck report: one row per stranded
 * job (short id, project, how long it has been resuming, when it entered that
 * state), a header, and a footer summarizing totals, how many are hidden by a
 * `--limit`, and how to recover. Reuses `formatDurationMs` so "2h 5m"/"3d 4h"
 * match the `stats`/`overdue` output. Pure: the spans come precomputed in the
 * report, so no ambient clock is read here.
 */
export function renderStuck(report: StuckReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (report.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    const grace = report.graceMs > 0 ? ` ${d(`(grace ${formatDurationMs(report.graceMs)})`)}` : "";
    return NO_STUCK_MESSAGE + note + grace;
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
 * generation timestamp, the optional active scope, and the full report —
 * entries plus the honest totals (`totalStuck`/`hidden`/`maxStuckForMs`) and the
 * `graceMs` applied.
 */
export function renderStuckJson(input: {
  storePath: string;
  generatedAt?: string;
  scope?: Record<string, unknown>;
  report: StuckReport;
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

function footer(report: StuckReport): string {
  const jobWord = report.totalStuck === 1 ? "job" : "jobs";
  const parts = [`${report.totalStuck} ${jobWord} stuck`];
  parts.push(`worst ${formatDurationMs(report.maxStuckForMs)}`);
  if (report.graceMs > 0) parts.push(`grace ${formatDurationMs(report.graceMs)}`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return (
    `${parts.join(" · ")}\n` +
    "If the resume loop is actually running these, they'll clear on their own — raise --grace for long agent runs.\n" +
    "If the loop died mid-resume (`agentrelay health`), recover a job with: `agentrelay cancel <id>` then `agentrelay retry <id>`."
  );
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
