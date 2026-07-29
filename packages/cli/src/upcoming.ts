// Rendering for `agentrelay upcoming` — the forward-looking resume timeline.
// Where `next` surfaces the single most imminent resume and `status` lists the
// whole queue in no particular time order, `upcoming` shows exactly the jobs
// waiting for a reset, in the order the scheduler will resume them, with the
// gap between consecutive resumes so the cadence is visible at a glance. Kept
// as pure functions (separate from the commander wiring) so the output is
// testable without a TTY, a clock, or a spawned process.

import type { UpcomingResumes } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";
import { formatCountdown } from "./status.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

/** Shown when no job is waiting for a reset (empty queue or only active/terminal jobs). */
export const NO_UPCOMING_MESSAGE = "No jobs waiting for a reset.";

/**
 * Human-friendly resume timeline: one line per upcoming resume (short id,
 * project, countdown, absolute reset time, and the "+gap" since the previous
 * resume), then a summary footer. Reuses `formatCountdown` so "due now"/"1h
 * 3m"/"2d 4h" match the status table exactly. Pure: no ambient clock unless
 * `now` is omitted; `color` gates ANSI codes (TTY only).
 */
export function renderUpcoming(result: UpcomingResumes, options: { now?: number; color?: boolean } = {}): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  if (result.entries.length === 0) return NO_UPCOMING_MESSAGE;

  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const g = (s: string): string => (color ? `${GREEN}${s}${RESET}` : s);

  const lines: string[] = [];
  result.entries.forEach((entry, index) => {
    const id = b(entry.job.id.slice(0, 8));
    const countdown = entry.due ? g("due now") : `resets in ${formatCountdown(entry.job.resetAt, now)}`;
    // The gap since the previous resume — omitted for the first row (nothing to
    // measure against) and for a zero gap (two resumes at the same instant).
    const gap = index > 0 && entry.gapFromPreviousMs > 0 ? d(`  (+${formatDurationMs(entry.gapFromPreviousMs)})`) : "";
    lines.push(`${id}  ${entry.job.project}  ${countdown}  ${d(`(${entry.job.resetAt})`)}${gap}`);
  });

  lines.push("");
  lines.push(d(summaryLine(result)));
  return lines.join("\n");
}

/** One-line footer, e.g. "3 of 5 waiting shown · timeline spans 2h 15m". */
function summaryLine(result: UpcomingResumes): string {
  const plural = result.totalWaiting === 1 ? "job" : "jobs";
  const shown =
    result.shown < result.totalWaiting
      ? `${result.shown} of ${result.totalWaiting} waiting ${plural} shown`
      : `${result.totalWaiting} ${plural} waiting for a reset`;
  const span = result.spanMs !== null ? ` · timeline spans ${formatDurationMs(result.spanMs)}` : "";
  return `${shown}${span}`;
}

/**
 * Machine-readable form for `--json` (scripts/jq): the full timeline with its
 * totals and span, so a monitor can chart the resume schedule without parsing
 * the human table.
 */
export function renderUpcomingJson(
  result: UpcomingResumes,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify({ storePath, generatedAt, ...result }, null, 2);
}
