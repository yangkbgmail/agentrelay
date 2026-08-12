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
export function renderEta(eta: QueueEta, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const g = (s: string): string => (color ? `${GREEN}${s}${RESET}` : s);

  if (eta.caughtUp) return g(CAUGHT_UP_MESSAGE);

  const plural = eta.waiting === 1 ? "job" : "jobs";
  // etaMs<=0 means even the last reset has passed: everything is due but the
  // resume loop hasn't caught up yet — phrase it as "due now" rather than "-".
  const when = eta.etaMs !== null && eta.etaMs > 0 ? `in ${b(formatDurationMs(eta.etaMs))}` : b("now (all due)");
  const head = `Queue caught up ${when}`;

  const facts = [`${eta.waiting} ${plural} waiting`];
  if (eta.dueNow > 0) facts.push(`${eta.dueNow} due now`);
  facts.push(`last resets at ${eta.lastResetAt}`);
  if (eta.spanMs !== null && eta.spanMs > 0) facts.push(`spread over ${formatDurationMs(eta.spanMs)}`);

  return `${head}\n${d(facts.join(", "))}.`;
}

/**
 * One frame of the live `agentrelay eta --watch` view: a title/header block
 * (matching the shape of `status`/`stats`/`upcoming --watch`) plus the always-
 * colored eta line, so the catch-up countdown ticks down in place. Like the
 * other watch frames this is pure — `now` is injected (used both to phrase an
 * already-due timeline and to stamp the banner), never read from an ambient
 * clock — so the frame is testable without a TTY or a real clock.
 */
export function renderEtaWatchFrame(
  eta: QueueEta,
  storePath: string,
  intervalMs: number,
  now: number = Date.now()
): string {
  const stamp = new Date(now).toISOString().replace("T", " ").slice(0, 19);
  const title = `${BOLD}agentrelay eta${RESET} ${DIM}(live, every ${Math.round(
    intervalMs / 1000
  )}s — Ctrl-C to exit)${RESET}`;
  const meta = `${DIM}${stamp}Z · ${storePath}${RESET}`;
  return [title, meta, "", renderEta(eta, { color: true })].join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq): the full `QueueEta` plus the
 * store path and generation timestamp, matching the envelope of `next --json`.
 */
export function renderEtaJson(
  eta: QueueEta,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify({ storePath, generatedAt, eta }, null, 2);
}
