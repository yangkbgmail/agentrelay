// Rendering for `agentrelay overdue` — the jobs the relay was supposed to
// resume but hasn't (reset time elapsed, still parked in waiting_for_reset).
// Where `next` looks forward at the soonest upcoming resume, `overdue` looks
// backward at resumes that are already late — the clearest sign the daemon
// isn't running or is stuck. Pure functions, separate from the commander
// wiring in cli.ts, so the exact output is unit-testable without a store.

import type { OverdueJob, OverdueReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

/** Shown when no job is waiting for a reset at all (empty queue or only active/terminal jobs). */
export const NO_WAITING_MESSAGE = "No jobs waiting for a reset.";

/** Shown when jobs are waiting but none are overdue — the relay is on schedule. */
export const NONE_OVERDUE_MESSAGE = "All waiting jobs are on schedule — none overdue.";

/** One overdue job as a block: ranked header (how late), the command's id/project, resetAt. */
function renderOverdueJob(entry: OverdueJob, index: number, color: boolean): string {
  const bold = color ? BOLD : "";
  const dim = color ? DIM : "";
  const red = color ? RED : "";
  const reset = color ? RESET : "";

  const id = entry.job.id.slice(0, 8);
  const late = formatDurationMs(entry.overdueMs);
  const header = `${bold}${index + 1}. ${id}${reset}  ${entry.job.project}  ${red}${late} overdue${reset}`;
  const detail = `   ${dim}reset was due ${entry.job.resetAt} · status ${entry.job.status}${reset}`;
  return [header, detail].join("\n");
}

/**
 * Render the overdue report as a multi-line block. Pure: no I/O. `color` gates
 * ANSI codes (TTY only). `limit` shows at most N jobs and appends a "M more not
 * shown" footer; the totals always reflect every overdue job. `scopeNote`, when
 * set, prints a "scope: …" line and switches the empty message accordingly.
 */
export function renderOverdue(
  report: OverdueReport,
  options: { color?: boolean; limit?: number; scopeNote?: string } = {}
): string {
  const color = options.color ?? false;
  const bold = color ? BOLD : "";
  const dim = color ? DIM : "";
  const green = color ? GREEN : "";
  const reset = color ? RESET : "";

  const lines: string[] = [];
  lines.push(`${bold}Overdue resumes${reset}`);
  if (options.scopeNote) lines.push(`${dim}scope: ${options.scopeNote}${reset}`);

  if (report.totalWaiting === 0) {
    lines.push("");
    lines.push(NO_WAITING_MESSAGE);
    return lines.join("\n");
  }

  if (report.overdueCount === 0) {
    lines.push("");
    lines.push(`${green}${NONE_OVERDUE_MESSAGE}${reset}`);
    lines.push(`${dim}${report.totalWaiting} job(s) waiting for a reset, all still within their window.${reset}`);
    return lines.join("\n");
  }

  const graceNote = report.graceMs > 0 ? ` (grace ${formatDurationMs(report.graceMs)})` : "";
  lines.push(
    `${dim}${report.overdueCount} of ${report.totalWaiting} waiting job(s) are overdue${graceNote} — ` +
      `the relay should have resumed them. Is the daemon running?${reset}`
  );
  lines.push("");

  const limit = options.limit;
  const shown = limit !== undefined ? report.jobs.slice(0, limit) : report.jobs;
  lines.push(shown.map((entry, i) => renderOverdueJob(entry, i, color)).join("\n\n"));

  const hidden = report.jobs.length - shown.length;
  if (hidden > 0) {
    lines.push("");
    lines.push(`${dim}… ${hidden} more overdue job(s) not shown (raise --limit)${reset}`);
  }

  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/monitoring). Echoes the store path
 * and active scope note (if any), plus the full report so `jq` can act on the
 * overdue list and durations.
 */
export function renderOverdueJson(
  report: OverdueReport,
  store: string,
  options: { scopeNote?: string; generatedAt?: string } = {}
): string {
  return JSON.stringify(
    {
      store,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      scope: options.scopeNote ?? null,
      totalWaiting: report.totalWaiting,
      overdueCount: report.overdueCount,
      graceMs: report.graceMs,
      jobs: report.jobs,
    },
    null,
    2
  );
}
