// Rendering for `agentrelay upcoming` — the resume timeline. Where `next`
// surfaces the single most imminent resume as a one-liner, `upcoming` lists
// every job waiting for a reset in the order the scheduler will pick them up,
// each with a countdown. It's the "what's the relay's whole plan?" view,
// sitting between `next` (one job) and `status` (the entire queue across all
// statuses). Kept as pure functions (separate from the commander wiring) so the
// output is testable without a TTY, a clock, or a spawned process.

import type { UpcomingResumes } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no job is waiting for a reset (empty queue or only active/terminal jobs). */
export const NO_PENDING_MESSAGE = "No jobs waiting for a reset.";

export interface RenderUpcomingOptions {
  now?: number;
  color?: boolean;
  /** Active scope note (e.g. "project=api tool=claude"), printed as a header when set. */
  scopeNote?: string;
}

/**
 * Human-friendly timeline: one line per pending resume (id, project, countdown,
 * absolute reset time), soonest first, plus an optional "N more waiting" footer
 * when a `--limit` hid some. Reuses `formatCountdown` so "due now"/"1h 3m"/"2d
 * 4h" match the status table and `next` exactly. Pure: no ambient clock unless
 * `now` is omitted.
 */
export function renderUpcoming(result: UpcomingResumes, options: RenderUpcomingOptions = {}): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (result.entries.length === 0) {
    lines.push(NO_PENDING_MESSAGE);
    return lines.join("\n");
  }

  for (const entry of result.entries) {
    const id = entry.job.id.slice(0, 8);
    const countdown = entry.due ? "due now" : `resets in ${formatCountdown(entry.job.resetAt, now)}`;
    lines.push(`${b(id)}  ${entry.job.project}  ${countdown}  ${d(`(${entry.job.resetAt})`)}`);
  }

  if (result.hidden > 0) {
    const plural = result.hidden === 1 ? "job" : "jobs";
    lines.push(d(`… and ${result.hidden} more ${plural} waiting (raise --limit to see them).`));
  }

  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq): the full timeline with each
 * job, its derived due state, and the total/hidden counts so a caller can page.
 */
export function renderUpcomingJson(
  result: UpcomingResumes,
  storePath: string,
  options: { scopeNote?: string; generatedAt?: string } = {}
): string {
  return JSON.stringify(
    {
      storePath,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      scope: options.scopeNote,
      totalWaiting: result.totalWaiting,
      hidden: result.hidden,
      upcoming: result.entries,
    },
    null,
    2
  );
}
