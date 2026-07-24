// Rendering for `agentrelay upcoming` — the forward-looking resume timeline.
// Where `next` surfaces the single most imminent resume and `status` snapshots
// the whole queue in any state, `upcoming` lists just the jobs waiting to
// resume, soonest-first, optionally windowed by `--within`. Kept as pure
// functions (separate from the commander wiring) so the output is testable
// without a TTY, a clock, or a spawned process.

import type { UpcomingResume } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no job is waiting for a reset within the (optional) window. */
export const NO_UPCOMING_MESSAGE = "No jobs waiting to resume.";

/** Shown when a window is active but filters everything out. */
export const NO_UPCOMING_IN_WINDOW_MESSAGE = "No jobs resume within the given window.";

export interface RenderUpcomingOptions {
  now?: number;
  color?: boolean;
  /** True when a `--within` window was applied (changes the empty-state text). */
  windowed?: boolean;
  /** How many matching entries were hidden by `--limit` (footer note). */
  hiddenByLimit?: number;
}

/**
 * Human-friendly table of upcoming resumes: one line per job (short id, project,
 * countdown, absolute reset), plus an optional "N more not shown" footer when a
 * `--limit` trims the list. Reuses `formatCountdown` so "due now"/"1h 3m"/"2d 4h"
 * match the status table exactly. Pure: no ambient clock unless `now` is omitted.
 */
export function renderUpcoming(entries: UpcomingResume[], options: RenderUpcomingOptions = {}): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (entries.length === 0) {
    return options.windowed ? NO_UPCOMING_IN_WINDOW_MESSAGE : NO_UPCOMING_MESSAGE;
  }

  const lines = entries.map((entry) => {
    const id = entry.job.id.slice(0, 8);
    const countdown = entry.due ? "due now" : `in ${formatCountdown(entry.job.resetAt, now)}`;
    return `${b(id)}  ${entry.job.project}  ${countdown}  ${d(`(${entry.job.resetAt})`)}`;
  });

  const hidden = options.hiddenByLimit ?? 0;
  if (hidden > 0) {
    const plural = hidden === 1 ? "job" : "jobs";
    lines.push(d(`… ${hidden} more ${plural} not shown (raise --limit to see them).`));
  }
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq): the full timeline plus the
 * store path and generation time. `count` is the number of entries returned.
 */
export function renderUpcomingJson(
  entries: UpcomingResume[],
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify({ storePath, generatedAt, count: entries.length, upcoming: entries }, null, 2);
}
