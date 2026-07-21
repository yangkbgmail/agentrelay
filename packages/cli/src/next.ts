// Rendering for `agentrelay next` — a scriptable one-liner answering "which
// job resumes next, and in how long?". Where `status` lists the whole queue,
// `next` surfaces the single most imminent resume, ideal for shell prompts,
// status bars, and cron deciding whether to poke the relay. Kept as pure
// functions (separate from the commander wiring) so the output is testable
// without a TTY, a clock, or a spawned process.

import type { JobScope, NextResume } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no job is waiting for a reset (empty queue or only active/terminal jobs). */
export const NO_PENDING_MESSAGE = "No jobs waiting for a reset.";

/**
 * Like {@link NO_PENDING_MESSAGE} but for when a `--tool`/`--project` scope is
 * active: distinguishes "nothing waiting anywhere" from "nothing waiting in the
 * scope you asked about", so a filtered query doesn't look like an empty queue.
 */
export const NO_SCOPED_PENDING_MESSAGE = "No jobs waiting for a reset in that scope.";

/**
 * Human-friendly single line (plus an optional "N more waiting" note) for the
 * next resume. Reuses `formatCountdown` so "due now"/"1h 3m"/"2d 4h" match the
 * status table exactly. Pure: no ambient clock unless `now` is omitted. When a
 * `--tool`/`--project` filter is active, pass `scopeNote` so the empty message
 * and (when a job is found) a trailing `scope: …` line reflect the narrowing.
 */
export function renderNext(
  next: NextResume | null,
  options: { now?: number; color?: boolean; scopeNote?: string } = {}
): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  const d0 = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  if (!next) return options.scopeNote ? NO_SCOPED_PENDING_MESSAGE : NO_PENDING_MESSAGE;

  const id = next.job.id.slice(0, 8);
  const countdown = next.due ? "due now" : `resets in ${formatCountdown(next.job.resetAt, now)}`;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = d0;

  const head = `${b(id)}  ${next.job.project}  ${countdown}  ${d(`(${next.job.resetAt})`)}`;
  const lines = [head];
  if (next.waitingBehind > 0) {
    const plural = next.waitingBehind === 1 ? "job" : "jobs";
    lines.push(d(`${next.waitingBehind} more ${plural} waiting behind it.`));
  }
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). `next` is null when nothing
 * is waiting; otherwise it carries the full job plus the derived due state. When
 * a `--tool`/`--project` filter was applied, the active `scope` is echoed so a
 * consumer can tell an unscoped query apart from a scoped one that matched nothing.
 */
export function renderNextJson(
  next: NextResume | null,
  storePath: string,
  options: { generatedAt?: string; scope?: JobScope } = {}
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const payload: { storePath: string; generatedAt: string; scope?: JobScope; next: NextResume | null } = {
    storePath,
    generatedAt,
    next,
  };
  if (options.scope) payload.scope = options.scope;
  return JSON.stringify(payload, null, 2);
}
