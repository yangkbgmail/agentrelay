// Rendering for `agentrelay upcoming` — the relay's resume schedule. Where
// `next` surfaces the single most imminent resume and `status` lists the whole
// queue in an arbitrary/filterable order, `upcoming` lists just the jobs
// waiting for a reset, in the exact order the scheduler will resume them, each
// with a countdown. Handy for "what's my relay going to do over the next few
// hours?". Kept as pure functions (separate from the commander wiring) so the
// output is testable without a TTY, a clock, or a spawned process.

import type { UpcomingResumes } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Shown when no job is waiting for a reset (empty queue or only active/terminal jobs). */
export const NO_UPCOMING_MESSAGE = "No jobs waiting for a reset.";

/** Widths for the fixed columns; project is sized to the widest entry (capped). */
const ID_WIDTH = 8;
const PROJECT_CAP = 20;

/**
 * Human-friendly resume schedule: an aligned table of position, short id,
 * project, and countdown, one row per upcoming resume. Reuses `formatCountdown`
 * so "due now"/"1h 30m"/"2d 4h" match the status table exactly. When a `limit`
 * hid some waiting jobs, a dim footer notes how many. Pure: no ambient clock
 * unless `now` is omitted.
 */
export function renderUpcoming(upcoming: UpcomingResumes, options: { now?: number; color?: boolean } = {}): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (upcoming.entries.length === 0) return NO_UPCOMING_MESSAGE;

  const posWidth = Math.max(1, String(upcoming.entries.length).length);
  const projWidth = Math.min(
    PROJECT_CAP,
    Math.max("PROJECT".length, ...upcoming.entries.map((e) => e.job.project.length))
  );

  const header = d(`${"#".padStart(posWidth)}  ${"ID".padEnd(ID_WIDTH)}  ${"PROJECT".padEnd(projWidth)}  RESETS IN`);

  const rows = upcoming.entries.map((e) => {
    const pos = String(e.position).padStart(posWidth);
    const id = e.job.id.slice(0, ID_WIDTH).padEnd(ID_WIDTH);
    const project = e.job.project.slice(0, projWidth).padEnd(projWidth);
    const countdown = e.due ? "due now" : formatCountdown(e.job.resetAt, now);
    return `${pos}  ${id}  ${project}  ${countdown}  ${d(`(${e.job.resetAt})`)}`;
  });

  const lines = [header, ...rows];
  if (upcoming.truncated) {
    const hidden = upcoming.totalWaiting - upcoming.entries.length;
    const plural = hidden === 1 ? "job" : "jobs";
    lines.push(d(`… ${hidden} more waiting ${plural} not shown.`));
  }
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq): the store path, a timestamp,
 * and the full {@link UpcomingResumes} (entries + totals) so a script can drive
 * off the exact resume order without re-deriving it.
 */
export function renderUpcomingJson(
  upcoming: UpcomingResumes,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify({ storePath, generatedAt, ...upcoming }, null, 2);
}
