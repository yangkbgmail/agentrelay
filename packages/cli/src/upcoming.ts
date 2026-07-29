// Rendering for `agentrelay upcoming` — a forward-looking agenda of when parked
// jobs will resume, grouped into time buckets (overdue / within the hour /
// later today / later). Where `next` shows the single most imminent resume and
// `status` lists the whole queue flat, `upcoming` answers "what does my resume
// schedule look like?" at a glance. Kept as pure functions (separate from the
// commander wiring) so the output is testable without a TTY or a clock.

import type { ResumeAgenda } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no job is waiting for a reset (empty queue or only active/terminal jobs). */
export const NO_UPCOMING_MESSAGE = "No jobs waiting for a reset.";

/** Shown when a scope filter excludes every job that would otherwise appear. */
export const NO_MATCH_MESSAGE = "No waiting jobs match the current filter.";

/**
 * Human-friendly agenda: a header per non-empty bucket, one row per parked job
 * (short id, project, tool, countdown, absolute reset), and a summary footer.
 * Reuses `formatCountdown` so "due now"/"1h 3m"/"2d 4h" match `status`/`next`
 * exactly. Pure: no ambient clock unless `now` is omitted.
 */
export function renderUpcoming(
  agenda: ResumeAgenda,
  options: { now?: number; color?: boolean; scopeNote?: string } = {}
): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (agenda.totalWaiting === 0) {
    return options.scopeNote ? NO_MATCH_MESSAGE : NO_UPCOMING_MESSAGE;
  }

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`), "");

  for (const bucket of agenda.buckets) {
    if (bucket.entries.length === 0) continue;
    lines.push(b(`${bucket.label}  (${bucket.entries.length})`));
    for (const entry of bucket.entries) {
      const id = entry.jobId.slice(0, 8);
      const countdown = entry.due ? "due now" : formatCountdown(entry.resetAt, now);
      lines.push(`  ${b(id)}  ${entry.project}  ${d(entry.tool)}  ${countdown}  ${d(`(${entry.resetAt})`)}`);
    }
    lines.push("");
  }

  const plural = agenda.totalWaiting === 1 ? "job" : "jobs";
  lines.push(d(`${agenda.totalWaiting} ${plural} waiting for a reset.`));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the full agenda plus
 * the store path, the scope (when a filter is active), and a generation stamp.
 */
export function renderUpcomingJson(input: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  agenda: ResumeAgenda;
}): string {
  return JSON.stringify(input, null, 2);
}
