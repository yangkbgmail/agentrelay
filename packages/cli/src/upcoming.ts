// Rendering for `agentrelay upcoming` — the relay's resume schedule as a
// compact timeline. Where `next` surfaces the single most imminent resume and
// `status` lists the whole queue (all statuses), `upcoming` answers "what's the
// runway?": every job waiting for a reset, in the exact order the scheduler
// will resume them, each with its countdown. Ideal for "when does my backlog
// actually come back?" at a glance. Kept as pure functions (separate from the
// commander wiring) so the output is testable without a TTY or a clock.

import type { UpcomingSchedule } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no job is waiting for a reset (empty queue or only active/terminal jobs). */
export const NO_UPCOMING_MESSAGE = "No jobs waiting for a reset.";

/**
 * Human-friendly resume schedule: one line per waiting job in scheduler order,
 * a header, and a summary footer (due-now count, plus "N more not shown" when a
 * `--limit` truncated the list). Reuses `formatCountdown` so "due now"/"1h 3m"/
 * "2d 4h" match the status table exactly. Pure: no ambient clock unless `now`
 * is omitted.
 */
export function renderUpcoming(schedule: UpcomingSchedule, options: { now?: number; color?: boolean } = {}): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (schedule.totalWaiting === 0) return NO_UPCOMING_MESSAGE;

  const lines: string[] = [];
  const plural = schedule.totalWaiting === 1 ? "job" : "jobs";
  lines.push(b(`Upcoming resumes (${schedule.totalWaiting} ${plural} waiting)`));

  for (const [index, resume] of schedule.resumes.entries()) {
    const ordinal = d(`${index + 1}.`.padStart(3));
    const id = b(resume.job.id.slice(0, 8));
    const countdown = resume.due ? "due now" : `resets in ${formatCountdown(resume.job.resetAt, now)}`;
    lines.push(`${ordinal} ${id}  ${resume.job.project}  ${countdown}  ${d(`(${resume.job.resetAt})`)}`);
  }

  const footerParts: string[] = [];
  if (schedule.dueNow > 0) {
    footerParts.push(`${schedule.dueNow} due now`);
  }
  if (schedule.hidden > 0) {
    const hiddenPlural = schedule.hidden === 1 ? "job" : "jobs";
    footerParts.push(`${schedule.hidden} more ${hiddenPlural} not shown`);
  }
  if (footerParts.length > 0) {
    lines.push(d(footerParts.join(" · ")));
  }

  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the full schedule
 * (each resume with its job + derived due state) plus the store path and a
 * generation timestamp, mirroring `renderNextJson`'s envelope.
 */
export function renderUpcomingJson(
  schedule: UpcomingSchedule,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify({ storePath, generatedAt, ...schedule }, null, 2);
}
