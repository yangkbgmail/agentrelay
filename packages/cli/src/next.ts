// Rendering for `agentrelay next` — a scriptable one-liner answering "which
// job resumes next, and in how long?". Where `status` lists the whole queue,
// `next` surfaces the single most imminent resume, ideal for shell prompts,
// status bars, and cron deciding whether to poke the relay. Kept as pure
// functions (separate from the commander wiring) so the output is testable
// without a TTY, a clock, or a spawned process.

import type { NextResume } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no job is waiting for a reset (empty queue or only active/terminal jobs). */
export const NO_PENDING_MESSAGE = "No jobs waiting for a reset.";

/**
 * Human-friendly single line (plus an optional "N more waiting" note) for the
 * next resume. Reuses `formatCountdown` so "due now"/"1h 3m"/"2d 4h" match the
 * status table exactly. Pure: no ambient clock unless `now` is omitted.
 */
export function renderNext(next: NextResume | null, options: { now?: number; color?: boolean } = {}): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  if (!next) return NO_PENDING_MESSAGE;

  const id = next.job.id.slice(0, 8);
  const countdown = next.due ? "due now" : `resets in ${formatCountdown(next.job.resetAt, now)}`;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  const head = `${b(id)}  ${next.job.project}  ${countdown}  ${d(`(${next.job.resetAt})`)}`;
  if (next.waitingBehind === 0) return head;
  const plural = next.waitingBehind === 1 ? "job" : "jobs";
  return `${head}\n${d(`${next.waitingBehind} more ${plural} waiting behind it.`)}`;
}

/**
 * Live-frame wrapper for `agentrelay next --watch`: the same banner shape as the
 * other `--watch` loops (title + timestamp/store meta + a blank line + body),
 * with the human-friendly next-resume line as its body so the countdown ticks
 * down in place. Pure: `now` is injected (used both for the timestamp and to
 * keep the body countdown live), never read from an ambient clock.
 */
export function renderNextWatchFrame(
  next: NextResume | null,
  storePath: string,
  intervalMs: number,
  now: number = Date.now()
): string {
  const stamp = new Date(now).toISOString().replace("T", " ").slice(0, 19);
  const title = `${BOLD}agentrelay next${RESET} ${DIM}(live, every ${Math.round(
    intervalMs / 1000
  )}s — Ctrl-C to exit)${RESET}`;
  const meta = `${DIM}${stamp}Z · ${storePath}${RESET}`;
  return [title, meta, "", renderNext(next, { color: true, now })].join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). `next` is null when nothing
 * is waiting; otherwise it carries the full job plus the derived due state.
 */
export function renderNextJson(
  next: NextResume | null,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify({ storePath, generatedAt, next }, null, 2);
}
