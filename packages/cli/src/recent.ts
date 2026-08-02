// Rendering for `agentrelay recent` — the rear-view mirror of the temporal-view
// family. Where `next`/`upcoming` look forward at what the relay will resume and
// `overdue` flags what is stuck, `recent` looks back at what it has actually
// resolved lately: the completed/failed/cancelled jobs, most-recent-first, each
// with how long ago it settled and how long the relay babysat it. Kept as pure
// functions (separate from the commander wiring) so the output is testable
// without a TTY, a clock, or a spawned process.

import type { RecentReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no job has resolved yet (empty store or only active jobs). */
export const NO_RECENT_MESSAGE = "No resolved jobs yet — nothing has completed, failed, or been cancelled.";

/** How each terminal status colours/labels its cell in the feed. */
const STATUS_LABEL: Record<string, string> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

/**
 * Human-friendly multi-line table for the recent-activity feed: one row per
 * resolved job (short id, project, status, how long ago it settled, how long it
 * took to resolve), a header, and a footer summarizing totals and how many are
 * hidden by a `--limit`. Reuses `formatDurationMs` so "2h 5m"/"3d 4h" match the
 * `stats`/`overdue` output. Pure: the spans come precomputed in the report.
 */
export function renderRecent(report: RecentReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (report.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    return NO_RECENT_MESSAGE + note;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(b(`${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("STATUS", 10)}  ${pad("WHEN", 10)}  TOOK`));

  for (const entry of report.entries) {
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const status = pad(STATUS_LABEL[entry.job.status] ?? entry.job.status, 10);
    const when = pad(formatAge(entry.ageMs), 10);
    const took = entry.resolutionMs === null ? d("-") : formatDurationMs(entry.resolutionMs);
    lines.push(`${b(id)}  ${project}  ${status}  ${d(when)}  ${took}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report —
 * entries plus the honest totals (`total`/`hidden`).
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

/** Render a relative age ("just now" / "3m ago" / "2h 5m ago"); "-" if unknown. */
function formatAge(ageMs: number | null): string {
  if (ageMs === null) return "-";
  if (ageMs < 1000) return "just now";
  return `${formatDurationMs(ageMs)} ago`;
}

function footer(report: RecentReport): string {
  const jobWord = report.total === 1 ? "job" : "jobs";
  const parts = [`${report.total} resolved ${jobWord}`];
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
