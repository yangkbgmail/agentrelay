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
 *
 * When `scopeNote` is set (the `--tool`/`--project`/`--since`/`--until` filters
 * are active), a dim `[scope: …]` line is appended — same convention as
 * `upcoming`/`overdue` — so it's clear the answer is for a subset of the queue,
 * including when the subset is empty (`NO_PENDING_MESSAGE`).
 */
export function renderNext(
  next: NextResume | null,
  options: { now?: number; color?: boolean; scopeNote?: string } = {}
): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const scopeLine = options.scopeNote ? `\n${d(`[scope: ${options.scopeNote}]`)}` : "";
  if (!next) return `${NO_PENDING_MESSAGE}${scopeLine}`;

  const id = next.job.id.slice(0, 8);
  const countdown = next.due ? "due now" : `resets in ${formatCountdown(next.job.resetAt, now)}`;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);

  const head = `${b(id)}  ${next.job.project}  ${countdown}  ${d(`(${next.job.resetAt})`)}`;
  if (next.waitingBehind === 0) return `${head}${scopeLine}`;
  const plural = next.waitingBehind === 1 ? "job" : "jobs";
  return `${head}\n${d(`${next.waitingBehind} more ${plural} waiting behind it.`)}${scopeLine}`;
}

/**
 * Machine-readable form for `--json` (scripts/jq). `next` is null when nothing
 * is waiting; otherwise it carries the full job plus the derived due state.
 * When a scope is active it is echoed under `scope` (matching `upcoming --json`)
 * so a consumer can tell the result was filtered.
 */
export function renderNextJson(
  next: NextResume | null,
  storePath: string,
  generatedAt: string = new Date().toISOString(),
  scope?: Record<string, unknown>
): string {
  return JSON.stringify({ storePath, generatedAt, scope, next }, null, 2);
}
