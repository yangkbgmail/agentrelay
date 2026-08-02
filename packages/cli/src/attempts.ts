// Rendering for `agentrelay attempts` — the "resume effort" diagnostic. It
// ranks jobs by how many times the relay has tried to resume them and warns
// which ones are about to exhaust their retry budget (and be marked `failed`).
// Where `errors` groups jobs that have already failed and `overdue` flags jobs
// a dead resume loop has stranded, `attempts` is the early-warning axis: jobs
// still in flight but circling the drain. Kept as pure functions (separate from
// the commander wiring in cli.ts) so the exact output is unit-testable without
// a store, a clock, or a spawned process.

import type { AttemptReport } from "@agentrelay/core";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** Shown when no in-scope job has needed a resume attempt yet. */
export const NO_ATTEMPTS_MESSAGE = "No jobs have needed a resume attempt yet — nothing to rank.";

/** Shown when a scope filter matches jobs but none of them has been retried. */
export const NO_ATTEMPTS_MATCH_MESSAGE = "No matching jobs have needed a resume attempt.";

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}

/** How many attempts remain, rendered as a count or "∞" for an unlimited budget. */
function renderRemaining(remaining: number | null): string {
  return remaining === null ? "∞" : String(remaining);
}

/**
 * Human-friendly table for the resume-effort report: one row per retried job
 * (short id, project, tool, status, attempts, attempts left), a header, and a
 * footer summarizing totals, the budget, and how many are at risk or hidden by
 * `--limit`. At-risk rows are marked with a leading `!` (and reddened when
 * color is on) so the jobs about to be given up on stand out. Pure: no I/O,
 * no clock. `color` gates ANSI codes (TTY only); `scopeNote`, when set, prints
 * a scope line and switches the empty message to the "no matching" variant.
 */
export function renderAttempts(report: AttemptReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const r = (s: string): string => (color ? `${RED}${s}${RESET}` : s);

  if (report.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    return (options.scopeNote ? NO_ATTEMPTS_MATCH_MESSAGE : NO_ATTEMPTS_MESSAGE) + note;
  }

  const projWidth = Math.min(24, Math.max(7, ...report.entries.map((e) => e.job.project.length)));
  const toolWidth = Math.min(12, Math.max(4, ...report.entries.map((e) => e.job.tool.length)));
  const statusWidth = Math.max(6, ...report.entries.map((e) => e.job.status.length));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(
    b(
      `${pad("", 1)} ${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("TOOL", toolWidth)}  ` +
        `${pad("STATUS", statusWidth)}  ${pad("TRIES", 5)}  LEFT`
    )
  );

  for (const entry of report.entries) {
    const marker = entry.atRisk ? r("!") : " ";
    const id = b(pad(entry.job.id.slice(0, 8), 8));
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const tool = pad(truncate(entry.job.tool, toolWidth), toolWidth);
    const status = pad(entry.job.status, statusWidth);
    const tries = pad(String(entry.attempts), 5);
    const left = renderRemaining(entry.remaining);
    const leftCell = entry.atRisk ? r(left) : left;
    lines.push(`${marker} ${id}  ${project}  ${tool}  ${status}  ${tries}  ${leftCell}`);
  }

  lines.push("");
  lines.push(d(footer(report)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full report — the
 * ranked entries plus the honest totals (`withAttempts`/`atRiskCount`/
 * `hidden`/`maxSingleAttempts`) and the `maxAttempts`/`riskThreshold` applied.
 */
export function renderAttemptsJson(input: {
  storePath: string;
  generatedAt?: string;
  scope?: Record<string, unknown>;
  report: AttemptReport;
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

function footer(report: AttemptReport): string {
  const jobWord = report.withAttempts === 1 ? "job" : "jobs";
  const parts = [`${report.withAttempts} ${jobWord} retried`];
  parts.push(`${report.totalAttempts} attempt${report.totalAttempts === 1 ? "" : "s"} total`);
  parts.push(`worst ${report.maxSingleAttempts}`);
  parts.push(report.maxAttempts > 0 ? `budget ${report.maxAttempts}` : "budget unlimited");
  if (report.atRiskCount > 0) parts.push(`${report.atRiskCount} at risk (!)`);
  if (report.hidden > 0) parts.push(`${report.hidden} more not shown`);
  const summary = parts.join(" · ");
  return report.atRiskCount > 0
    ? `${summary}\nJobs marked ! are near the retry budget; they'll be marked failed if they exhaust it.`
    : summary;
}
