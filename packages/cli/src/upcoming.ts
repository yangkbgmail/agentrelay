// Rendering for `agentrelay upcoming` — the resume timeline. Where `next`
// surfaces the single most imminent resume and `status` lists the whole queue
// (active/terminal jobs included), `upcoming` is the focused agenda of every
// job the relay will resume, in the exact order the daemon will pick them up,
// each with its own countdown. Ideal for "what's my day of resumes look like?".
// Pure functions (separate from the commander wiring in cli.ts) so the output
// is testable without a TTY or a clock.

import type { UpcomingResumes } from "@agentrelay/core";
import { NO_PENDING_MESSAGE } from "./next.js";
import { formatCountdown } from "./status.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

/** Cap on the project column so one long project name doesn't blow out the table. */
const PROJECT_MAX = 24;

/**
 * Human-readable timeline: a header with the waiting/due counts, then one line
 * per upcoming resume with a due marker (`●` due now / `○` pending), short id,
 * project, countdown, and the absolute reset time. When the view is truncated
 * (`--limit`), a trailing "… N more not shown" keeps the totals honest. Reuses
 * `formatCountdown` so "due now"/"1h 3m"/"2d 4h" match the status table exactly.
 * Pure: no ambient clock/color unless `now`/`color` are passed.
 */
export function renderUpcoming(result: UpcomingResumes, options: { now?: number; color?: boolean } = {}): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const g = (s: string): string => (color ? `${GREEN}${s}${RESET}` : s);

  if (result.totalWaiting === 0) return NO_PENDING_MESSAGE;

  const plural = result.totalWaiting === 1 ? "job" : "jobs";
  const dueNote = result.dueNow > 0 ? `, ${result.dueNow} due now` : "";
  const lines: string[] = [`${b("Upcoming resumes")}${d(` — ${result.totalWaiting} ${plural} waiting${dueNote}`)}`];

  // Size the project/countdown columns to the rows actually shown so the
  // absolute-time column lines up without a fixed guess.
  const projectWidth = Math.min(
    PROJECT_MAX,
    result.entries.reduce((max, e) => Math.max(max, e.job.project.length), 0)
  );
  const countdowns = result.entries.map((e) => (e.due ? "due now" : `in ${formatCountdown(e.job.resetAt, now)}`));
  const countdownWidth = countdowns.reduce((max, c) => Math.max(max, c.length), 0);

  result.entries.forEach((entry, i) => {
    const marker = entry.due ? g("●") : d("○");
    const id = entry.job.id.slice(0, 8);
    const project = entry.job.project.slice(0, PROJECT_MAX).padEnd(projectWidth);
    const countdown = countdowns[i].padEnd(countdownWidth);
    lines.push(`  ${marker} ${b(id)}  ${project}  ${countdown}  ${d(entry.job.resetAt ?? "")}`);
  });

  const hidden = result.totalWaiting - result.entries.length;
  if (hidden > 0) {
    const hiddenPlural = hidden === 1 ? "job" : "jobs";
    lines.push(d(`  … ${hidden} more ${hiddenPlural} not shown`));
  }
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq): the full timeline plus the
 * store it describes and when it was generated.
 */
export function renderUpcomingJson(
  result: UpcomingResumes,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify({ storePath, generatedAt, upcoming: result }, null, 2);
}
