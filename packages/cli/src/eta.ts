// Rendering for `agentrelay eta` — a scriptable one-liner answering "when will
// the relay have caught up on my whole backlog?". Where `next` surfaces the
// single soonest resume, `eta` reports the *last* reset among all waiting jobs:
// the moment the queue is fully unblocked. Ideal for a status bar that shows
// "all clear in 3h" or a script that waits out the entire rate-limit window.
// Kept as pure functions (separate from the commander wiring) so the output is
// testable without a TTY, a clock, or a spawned process.

import type { QueueEta } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no job is waiting for a reset (empty queue or only active/terminal jobs). */
export const NO_PENDING_MESSAGE = "No jobs waiting for a reset.";

/**
 * Human-friendly summary of the queue-drain forecast. Reuses `formatCountdown`
 * so "due now"/"1h 3m"/"2d 4h" match the status table exactly. Pure: no ambient
 * clock unless `now` is omitted.
 */
export function renderEta(eta: QueueEta | null, options: { now?: number; color?: boolean } = {}): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  if (!eta) return NO_PENDING_MESSAGE;

  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  const plural = eta.waitingCount === 1 ? "job" : "jobs";
  if (eta.allDue) {
    // Everything's reset already — the next tick drains the backlog.
    return `${b("all clear")}  ${eta.waitingCount} ${plural} due now  ${d(`(last reset ${eta.lastResetAt})`)}`;
  }

  const clearIn = `all clear in ${formatCountdown(eta.lastResetAt, now)}`;
  const head = `${b(clearIn)}  ${eta.waitingCount} ${plural} waiting  ${d(`(last reset ${eta.lastResetAt})`)}`;
  const dueNote = eta.dueNow > 0 ? d(`\n${eta.dueNow} of them due now; next tick starts draining.`) : "";
  return `${head}${dueNote}`;
}

/**
 * Machine-readable form for `--json` (scripts/jq). `eta` is null when nothing
 * is waiting; otherwise it carries the first/last reset window and due counts.
 */
export function renderEtaJson(
  eta: QueueEta | null,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify({ storePath, generatedAt, eta }, null, 2);
}
