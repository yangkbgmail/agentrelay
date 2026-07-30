// Rendering for `agentrelay retries` — the jobs the relay has re-run the most,
// ranked by attempt count. Where `errors` groups failures by message and
// `stats` reports an aggregate retry count, this names the specific jobs eating
// the retry budget: the ones repeatedly hitting rate-limits or transient
// failures, worth a closer look with `agentrelay show`. Kept as pure functions
// (separate from the commander wiring) so the output is testable without a TTY.

import type { RetriesReport } from "@agentrelay/core";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no job has been retried (every job ran through on its first attempt). */
export const NO_RETRIES_MESSAGE = "No jobs have been retried.";

/**
 * Human-friendly multi-line table for the retries report: one row per
 * most-retried job (position, short id, project, status, attempt count), a
 * header, and a footer summarizing the qualifying total, the retry budget
 * spent, and how many rows are hidden by a `--limit`. Pure: no I/O, no clock.
 */
export function renderRetries(report: RetriesReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  const floorNote = d(`(min attempts: ${report.minAttempts})`);

  if (report.entries.length === 0) {
    const scope = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    return `${NO_RETRIES_MESSAGE} ${floorNote}${scope}`;
  }

  const projWidth = Math.min(28, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const statusWidth = Math.max(6, ...report.entries.map((e) => e.job.status.length));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(
    b(`${pad("#", 3)}  ${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("STATUS", statusWidth)}  ATTEMPTS`)
  );

  for (const entry of report.entries) {
    const pos = pad(String(entry.position), 3);
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const status = pad(entry.job.status, statusWidth);
    lines.push(`${pos}  ${b(id)}  ${project}  ${d(status)}  ${b(String(entry.attempts))}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report —
 * entries plus the honest totals (`totalRetried`/`totalAttempts`/`maxAttempts`)
 * and the `minAttempts` floor that was applied.
 */
export function renderRetriesJson(input: {
  storePath: string;
  generatedAt?: string;
  scope?: Record<string, unknown>;
  report: RetriesReport;
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

function footer(report: RetriesReport): string {
  const jobWord = report.totalRetried === 1 ? "job" : "jobs";
  const parts = [`${report.totalRetried} ${jobWord} retried`, `${report.totalAttempts} attempts total`];
  if (report.maxAttempts > 0) parts.push(`max ${report.maxAttempts}`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
