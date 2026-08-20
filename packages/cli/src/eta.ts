// Rendering for `agentrelay eta` — a scriptable one-liner answering "when is the
// whole queue caught up?". Where `next` surfaces the single soonest resume and
// `upcoming` lists the runway, `eta` reports the countdown to the *latest* reset
// among all waiting jobs — the moment the relay has nothing left to wait on.
// Ideal for a shell prompt, a status bar, or a script deciding whether it can
// stop watching. Kept as pure functions (separate from the commander wiring) so
// the output is testable without a TTY, a clock, or a spawned process.

import type { QueueEta } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

/** Shown when no job is waiting for a reset (empty queue or only active/terminal jobs). */
export const CAUGHT_UP_MESSAGE = "Queue is caught up — no jobs waiting for a reset.";

/**
 * Human-friendly single line for the catch-up ETA. Reuses `formatDurationMs`
 * so "1h 3m"/"2d 4h" match `stats`/`overdue` exactly. Pure: no ambient clock
 * unless `now` is omitted (used only to phrase already-due timelines).
 */
export function renderEta(eta: QueueEta, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const g = (s: string): string => (color ? `${GREEN}${s}${RESET}` : s);
  const scopeLine = options.scopeNote ? `\n${d(`[scope: ${options.scopeNote}]`)}` : "";

  if (eta.caughtUp) return `${g(CAUGHT_UP_MESSAGE)}${scopeLine}`;

  const plural = eta.waiting === 1 ? "job" : "jobs";
  // etaMs<=0 means even the last reset has passed: everything is due but the
  // resume loop hasn't caught up yet — phrase it as "due now" rather than "-".
  const when = eta.etaMs !== null && eta.etaMs > 0 ? `in ${b(formatDurationMs(eta.etaMs))}` : b("now (all due)");
  const head = `Queue caught up ${when}`;

  const facts = [`${eta.waiting} ${plural} waiting`];
  if (eta.dueNow > 0) facts.push(`${eta.dueNow} due now`);
  facts.push(`last resets at ${eta.lastResetAt}`);
  if (eta.spanMs !== null && eta.spanMs > 0) facts.push(`spread over ${formatDurationMs(eta.spanMs)}`);

  return `${head}\n${d(facts.join(", "))}.${scopeLine}`;
}

/**
 * Machine-readable form for `--json` (scripts/jq): the full `QueueEta` plus the
 * store path and generation timestamp, matching the envelope of `next --json`.
 * When a scope is active it is echoed under `scope` (same as `next`/`upcoming
 * --json`); `undefined` is dropped by `JSON.stringify` so the unscoped shape is
 * unchanged.
 */
export function renderEtaJson(
  eta: QueueEta,
  storePath: string,
  generatedAt: string = new Date().toISOString(),
  scope?: Record<string, unknown>
): string {
  return JSON.stringify({ storePath, generatedAt, scope, eta }, null, 2);
}
