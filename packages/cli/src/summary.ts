// Rendering for `agentrelay summary` — the smallest at-a-glance view of the
// queue: how many jobs, how they split across statuses, and how long until the
// next reset. Where `status` prints the full per-job table and `next` surfaces
// the single most imminent resume, `summary` answers "what's the queue doing
// right now?" in one or two lines — ideal for a shell prompt, a `watch`, or a
// scripted health probe. Kept as pure functions (separate from the commander
// wiring in cli.ts) so the exact output is unit-testable without a TTY, a
// clock, or a spawned process.

import type { JobStatus, QueueSummary } from "@agentrelay/core";
import { ALL_STATUSES } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

/** ANSI color per status, applied only when the output is going to a TTY. */
const STATUS_COLOR: Record<JobStatus, string> = {
  queued: "\x1b[36m", // cyan
  waiting_for_reset: "\x1b[33m", // yellow
  resuming: "\x1b[35m", // magenta
  completed: "\x1b[32m", // green
  failed: "\x1b[31m", // red
  cancelled: "\x1b[90m", // gray
};

/** Shown when the store has no jobs at all. */
export const EMPTY_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project`/`--since`/`--until` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/**
 * Compact human overview: a headline (total jobs + next-reset countdown) and a
 * per-status breakdown that omits zero-count statuses for scannability. Reuses
 * `formatCountdown` so the "1h 3m"/"due now" phrasing matches the status table
 * exactly. Pure: no ambient clock unless `now` is omitted. A `scopeNote` is
 * echoed once at the top when a filter is active (matching `tools`/`projects`),
 * and the empty message reflects whether a filter is in play.
 */
export function renderSummary(
  summary: QueueSummary,
  options: { now?: number; color?: boolean; scopeNote?: string } = {}
): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const scopeLine = options.scopeNote ? `${d(`scope: ${options.scopeNote}`)}\n` : "";

  if (summary.total === 0) return `${scopeLine}${options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : EMPTY_MESSAGE}`;

  const jobWord = summary.total === 1 ? "job" : "jobs";
  const reset =
    summary.nextResetAt !== null
      ? `next reset in ${b(formatCountdown(summary.nextResetAt, now))} ${d(`(${summary.nextResetAt})`)}`
      : d("nothing waiting for a reset");
  const headline = `${b(`${summary.total} ${jobWord}`)} ${d("·")} ${reset}`;

  // Breakdown: lifecycle order, non-zero only, colored count per status.
  const parts = ALL_STATUSES.filter((status) => summary.byStatus[status] > 0).map((status) => {
    const count = summary.byStatus[status];
    const painted = color ? `${STATUS_COLOR[status]}${status}${RESET}` : status;
    return `${painted} ${b(String(count))}`;
  });
  const breakdown = parts.length > 0 ? `  ${parts.join(d("  "))}` : "";

  const body = breakdown ? `${headline}\n${breakdown}` : headline;
  return `${scopeLine}${body}`;
}

/**
 * One frame of the live `agentrelay summary --watch` view: a title/header block
 * (matching the shape of `status`/`tools`/`projects --watch`) followed by the
 * colored one-glance overview. Separated out so the watch loop only has to clear
 * the screen and print this. The next-reset countdown ticks down in place because
 * the loop re-reads the store and rebuilds the summary with a fresh `now` each
 * pass. Pure: `now` is injected for the timestamp and the countdown.
 */
export function renderSummaryWatchFrame(
  summary: QueueSummary,
  storePath: string,
  intervalMs: number,
  now: number = Date.now(),
  scopeNote?: string
): string {
  const stamp = new Date(now).toISOString().replace("T", " ").slice(0, 19);
  const title = `${BOLD}agentrelay summary${RESET} ${DIM}(live, every ${Math.round(
    intervalMs / 1000
  )}s — Ctrl-C to exit)${RESET}`;
  const meta = `${DIM}${stamp}Z · ${storePath}${RESET}`;
  return [title, meta, "", renderSummary(summary, { color: true, now, scopeNote })].join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the full
 * `QueueSummary` (total, per-status counts with every status zero-filled, and
 * the next reset) plus provenance for where the data came from and when.
 */
export function renderSummaryJson(
  summary: QueueSummary,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify({ storePath, generatedAt, summary }, null, 2);
}
