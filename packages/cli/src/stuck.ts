// Rendering for `agentrelay stuck` — the complement of `overdue`. Where
// `overdue` flags `waiting_for_reset` jobs whose reset time has passed but that
// never resumed, `stuck` flags jobs abandoned in a *transient* state
// (`queued`/`resuming`) — the quiet failure mode where a resume was spawned but
// its process died before the daemon recorded an outcome, leaving a permanently
// half-resumed record no tick will ever touch again. Kept as pure functions
// (separate from the commander wiring) so the output is testable without a TTY,
// a clock, or a spawned process.

import type { StuckReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no transient-state job is stuck — the relay isn't leaving jobs mid-flight. */
export const NO_STUCK_MESSAGE = "No stuck jobs — nothing is stranded mid-flight.";

/**
 * Human-friendly multi-line table for the stuck report: one row per stranded
 * job (short id, project, its transient status, how long it has been idle, when
 * it was last touched), a header, and a footer summarizing totals, the applied
 * threshold, and how many are hidden by a `--limit`. Reuses `formatDurationMs`
 * so "2h 5m"/"3d 4h" match the `stats`/`overdue` output. Pure: no ambient
 * clock (the idle spans come precomputed in the report).
 */
export function renderStuck(report: StuckReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (report.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    const thresh = ` ${d(`(threshold ${formatDurationMs(report.thresholdMs)}, statuses: ${report.statuses.join("/")})`)}`;
    return NO_STUCK_MESSAGE + note + thresh;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const statusWidth = Math.max(6, ...report.entries.map((e) => e.job.status.length));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(
    b(`${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("STATUS", statusWidth)}  ${pad("IDLE", 12)}  LAST UPDATE`)
  );

  for (const entry of report.entries) {
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const status = pad(entry.job.status, statusWidth);
    const idle = pad(formatDurationMs(entry.idleMs), 12);
    lines.push(`${b(id)}  ${project}  ${status}  ${idle}  ${d(entry.job.updatedAt)}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report —
 * entries plus the honest totals (`totalStuck`/`hidden`/`maxIdleMs`), the
 * `thresholdMs` applied, and the `statuses` considered.
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
  parts.push(`worst ${formatDurationMs(report.maxIdleMs)}`);
  parts.push(`threshold ${formatDurationMs(report.thresholdMs)}`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return (
    `${parts.join(" · ")}\n` +
    "A resuming job that never finished usually means its agent process died mid-resume;\n" +
    "inspect one with `agentrelay show <id>`, then re-queue it (`agentrelay retry <id>`) or drop it (`agentrelay cancel <id>`)."
  );
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
