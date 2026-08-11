// Rendering for `agentrelay prompt` — a status *segment* meant to be embedded
// in a shell prompt (PS1), a tmux `status-right`, or a starship custom command.
// Where `summary` prints a human one-to-two-line overview and `status` the full
// per-job table, `prompt` collapses the queue to a single ultra-terse token —
// e.g. `⏳3 ▶1 (1h 3m)` — that answers "is the relay babysitting anything, and
// when's the next resume?" at a glance, every time the shell redraws.
//
// Three properties make this different from `summary`, and they drive the
// design:
//   1. Silent when idle. An empty queue renders the empty string so the prompt
//      shows nothing at all (unless `--zero` opts into an idle marker). A shell
//      prompt that always printed something would be noise.
//   2. No color by default. ANSI escapes inside a `$(...)` command substitution
//      throw off the shell's width calculation and cause line-wrapping glitches
//      in PS1. Color is strictly opt-in via `--color`; even a TTY does not turn
//      it on here (the opposite of `summary`).
//   3. Never breaks the prompt. The command wiring degrades any error (bad
//      scope, unreadable store) to empty stdout + exit 0, so a broken relay can
//      never wedge the user's shell.
//
// Kept as pure functions (separate from the commander wiring in cli.ts) so the
// exact output is unit-testable without a TTY, a clock, or a spawned process.

import type { QueueSummary } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m"; // waiting_for_reset
const MAGENTA = "\x1b[35m"; // resuming / queued (in-flight)
const GREEN = "\x1b[32m"; // idle marker

/** Glyph vocabulary for the default (emoji-capable) rendering. */
const GLYPH = { waiting: "⏳", running: "▶", idle: "✓" } as const;
/** ASCII vocabulary for `--plain` (terminals/fonts without emoji). */
const PLAIN = { waiting: "wait", running: "run", idle: "ok" } as const;

export interface PromptOptions {
  /** Reference time for the reset countdown. Defaults to now. */
  now?: number;
  /** Use ASCII labels (`wait:3 run:1`) instead of glyphs (`⏳3 ▶1`). */
  plain?: boolean;
  /** Emit an idle marker when the queue has no pending work, instead of "". */
  zero?: boolean;
  /** Opt into ANSI color. Off by default — safe for embedding in PS1. */
  color?: boolean;
}

/**
 * Two counts drive the segment: jobs the relay is waiting to resume
 * (`waiting_for_reset`) and jobs that are in-flight — either freshly enqueued
 * (`queued`) or actively re-running (`resuming`). Terminal states
 * (completed/failed/cancelled) are deliberately excluded: a prompt reflects
 * *live* work, not history (use `stats`/`errors` for that).
 */
export function promptCounts(summary: QueueSummary): { waiting: number; running: number; pending: number } {
  const waiting = summary.byStatus.waiting_for_reset;
  const running = summary.byStatus.queued + summary.byStatus.resuming;
  return { waiting, running, pending: waiting + running };
}

/**
 * Render the single-line prompt segment. Returns "" when nothing is pending
 * (unless `zero` is set). Reuses `formatCountdown` so the "1h 3m"/"due now"
 * phrasing matches every other view. Pure: no ambient clock unless `now` is
 * omitted, no color unless `color` is set.
 */
export function renderPrompt(summary: QueueSummary, options: PromptOptions = {}): string {
  const now = options.now ?? Date.now();
  const plain = options.plain ?? false;
  const color = options.color ?? false;
  const sym = plain ? PLAIN : GLYPH;
  const paint = (code: string, s: string): string => (color ? `${code}${s}${RESET}` : s);

  const { waiting, running, pending } = promptCounts(summary);

  if (pending === 0) {
    return options.zero ? paint(GREEN, sym.idle) : "";
  }

  const parts: string[] = [];
  if (waiting > 0) {
    const token = plain ? `${sym.waiting}:${waiting}` : `${sym.waiting}${waiting}`;
    parts.push(paint(YELLOW, token));
  }
  if (running > 0) {
    const token = plain ? `${sym.running}:${running}` : `${sym.running}${running}`;
    parts.push(paint(MAGENTA, token));
  }
  // Countdown to the nearest reset — only meaningful when something waits.
  if (summary.nextResetAt !== null) {
    parts.push(paint(DIM, `(${formatCountdown(summary.nextResetAt, now)})`));
  }

  return parts.join(" ");
}

/**
 * Machine-readable form for `--json` (scripts, status-bar plugins that prefer
 * structured input). Carries the split counts, the pending total, the next
 * reset (ISO + a pre-rendered countdown), and the full per-status breakdown,
 * plus provenance for where the data came from and when.
 */
export function renderPromptJson(
  summary: QueueSummary,
  storePath: string,
  options: { now?: number; generatedAt?: string } = {}
): string {
  const now = options.now ?? Date.now();
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const { waiting, running, pending } = promptCounts(summary);
  return JSON.stringify(
    {
      storePath,
      generatedAt,
      waiting,
      running,
      pending,
      nextResetAt: summary.nextResetAt,
      nextResetCountdown: summary.nextResetAt !== null ? formatCountdown(summary.nextResetAt, now) : null,
      byStatus: summary.byStatus,
    },
    null,
    2
  );
}
