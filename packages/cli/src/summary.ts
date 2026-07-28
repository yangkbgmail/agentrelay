// Rendering helpers for `agentrelay summary` — a terse, scriptable one-line
// snapshot of the queue meant for shell prompts, tmux status bars, CI badges,
// and quick "is anything stuck?" checks. Unlike `status` (a full table) this is
// deliberately a single line, and unlike the `status` footer it exposes a
// single-value `--field` accessor so scripts can read a count without piping
// through `jq`.
//
// Pure: no I/O and no ambient clock unless `now` is omitted. The command layer
// (commands.ts / cli.ts) reads the store and feeds a QueueSummary in here.

import type { JobStatus, QueueSummary } from "@agentrelay/core";
import { ALL_STATUSES } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

/** Compact, human-friendly label per status for the terse line. */
const SHORT_LABEL: Record<JobStatus, string> = {
  queued: "queued",
  waiting_for_reset: "waiting",
  resuming: "resuming",
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/** ASCII-safe-ish glyphs for `--icons` (opt-in; prompts vary in emoji support). */
const ICON: Record<JobStatus, string> = {
  queued: "•",
  waiting_for_reset: "⏳",
  resuming: "▶",
  completed: "✔",
  failed: "✖",
  cancelled: "⊘",
};

/**
 * Statuses that count as "in flight": the relay still owes these jobs work.
 * Backs the `active` field and JSON key. In lifecycle order.
 */
export const ACTIVE_STATUSES: readonly JobStatus[] = ["queued", "waiting_for_reset", "resuming"];

export interface SummaryLineOptions {
  /** Reference clock for the reset countdown. Defaults to Date.now(). */
  now?: number;
  /** Prefix each count with a glyph instead of a word. Default false. */
  icons?: boolean;
}

function activeCount(summary: QueueSummary): number {
  return ACTIVE_STATUSES.reduce((sum, s) => sum + summary.byStatus[s], 0);
}

/** Milliseconds until the next reset, or null when nothing is waiting. Never negative. */
export function nextResetInMs(summary: QueueSummary, now: number): number | null {
  if (summary.nextResetAt === null) return null;
  const target = new Date(summary.nextResetAt).getTime();
  if (Number.isNaN(target)) return null;
  return Math.max(0, target - now);
}

/**
 * The terse one-liner. Only non-zero statuses appear, in lifecycle order, and a
 * "next reset in …" clause is appended whenever a job is waiting. An empty store
 * renders "no jobs" so the line is never blank (safe to embed in a prompt).
 *
 * Examples:
 *   "2 waiting · 1 done · next reset in 12m"
 *   "⏳2 ✔1 · next 12m"            (--icons)
 *   "no jobs"
 */
export function renderSummaryLine(summary: QueueSummary, options: SummaryLineOptions = {}): string {
  const now = options.now ?? Date.now();
  const icons = options.icons ?? false;

  const parts = ALL_STATUSES.filter((s) => summary.byStatus[s] > 0).map((s) =>
    icons ? `${ICON[s]}${summary.byStatus[s]}` : `${summary.byStatus[s]} ${SHORT_LABEL[s]}`
  );

  // Glyph counts pack tightly with a space; word counts need a "·" separator so
  // "2 waiting 1 done" doesn't read as one clause.
  const body = parts.length > 0 ? parts.join(icons ? " " : " · ") : "no jobs";

  if (summary.nextResetAt === null) return body;
  const countdown = formatCountdown(summary.nextResetAt, now);
  const clause = icons ? `next ${countdown}` : `next reset in ${countdown}`;
  return `${body} · ${clause}`;
}

/** Every value `--field` understands, for validation and help text. */
export const SUMMARY_FIELDS = [
  "total",
  "active",
  "queued",
  "waiting",
  "resuming",
  "completed",
  "failed",
  "cancelled",
  "next_reset_at",
  "next_reset_ms",
  "next_reset",
] as const;

export type SummaryField = (typeof SUMMARY_FIELDS)[number];

export function isSummaryField(value: string): value is SummaryField {
  return (SUMMARY_FIELDS as readonly string[]).includes(value);
}

/**
 * Single-value accessor for `agentrelay summary --field <name>`. Returns a bare
 * string (no trailing newline) so scripts can capture it directly, e.g.
 * `[ "$(agentrelay summary --field failed)" -gt 0 ]`.
 *
 * Numeric fields print an integer; `next_reset_at` is the ISO string (empty when
 * nothing waits); `next_reset_ms` is the ms remaining (empty when none);
 * `next_reset` is the human countdown ("-" when none).
 */
export function summaryFieldValue(summary: QueueSummary, field: SummaryField, now: number = Date.now()): string {
  switch (field) {
    case "total":
      return String(summary.total);
    case "active":
      return String(activeCount(summary));
    case "queued":
      return String(summary.byStatus.queued);
    case "waiting":
      return String(summary.byStatus.waiting_for_reset);
    case "resuming":
      return String(summary.byStatus.resuming);
    case "completed":
      return String(summary.byStatus.completed);
    case "failed":
      return String(summary.byStatus.failed);
    case "cancelled":
      return String(summary.byStatus.cancelled);
    case "next_reset_at":
      return summary.nextResetAt ?? "";
    case "next_reset_ms": {
      const ms = nextResetInMs(summary, now);
      return ms === null ? "" : String(ms);
    }
    case "next_reset":
      return formatCountdown(summary.nextResetAt, now);
  }
}

/**
 * Machine-readable snapshot for `--json`. Adds `active` and `nextResetInMs` on
 * top of the raw QueueSummary so scripts don't have to recompute them.
 */
export function renderSummaryJson(summary: QueueSummary, now: number = Date.now(), storePath?: string): string {
  return JSON.stringify(
    {
      ...(storePath !== undefined ? { storePath } : {}),
      total: summary.total,
      active: activeCount(summary),
      byStatus: summary.byStatus,
      nextResetAt: summary.nextResetAt,
      nextResetInMs: nextResetInMs(summary, now),
    },
    null,
    2
  );
}
