// Rendering for `agentrelay overdue` — a diagnostic listing jobs the relay
// should already have resumed. Where `doctor`'s heartbeat check says whether
// the resume loop is alive and `next` names the single soonest resume, this
// lists every `waiting_for_reset` job whose reset time has passed by more than
// the threshold, ranked worst-first, so a stalled relay (crashed poll loop,
// clock skew, a wedged spawn) is obvious at a glance. Pure functions, separate
// from the commander wiring, so the output is testable without a TTY or clock.

import type { OverdueReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no waiting job is overdue (healthy, or nothing waiting at all). */
export const NO_OVERDUE_MESSAGE = "No overdue jobs — the relay is keeping up.";

/**
 * Human-readable block for the overdue report: a heading with the overdue/total
 * split, then one line per overdue job (short id · project · how overdue · the
 * reset it slipped past). Pure: `color` gates ANSI codes (TTY only).
 */
export function renderOverdue(report: OverdueReport, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (report.jobs.length === 0) {
    if (report.totalWaiting === 0) return NO_OVERDUE_MESSAGE;
    const plural = report.totalWaiting === 1 ? "job" : "jobs";
    return `${NO_OVERDUE_MESSAGE}\n${d(`${report.totalWaiting} ${plural} waiting for a reset, none overdue.`)}`;
  }

  const count = report.jobs.length;
  const noun = count === 1 ? "job" : "jobs";
  const lines: string[] = [
    b(`${count} overdue ${noun} of ${report.totalWaiting} waiting for a reset`),
    d("These should already have resumed — is the daemon running? (`agentrelay doctor`)"),
  ];

  for (const { job, overdueMs } of report.jobs) {
    lines.push(
      `  ${b(job.id.slice(0, 8))}  ${job.project}  overdue ${formatDurationMs(overdueMs)}  ${d(`(reset ${job.resetAt})`)}`
    );
  }

  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq): the store path, the moment
 * the report was generated, and the full report (jobs + counts).
 */
export function renderOverdueJson(
  report: OverdueReport,
  storePath: string,
  options: { generatedAt?: string; scopeNote?: string } = {}
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  return JSON.stringify({ storePath, generatedAt, scope: options.scopeNote ?? null, ...report }, null, 2);
}
