// Rendering for `agentrelay summary` — a compact, single-line overview of the
// whole queue, meant to be embedded in a shell prompt, a tmux/status bar, or a
// CI step. It sits between `status` (the full table), `next` (only the single
// most imminent resume), and `stats` (a multi-line block): one glanceable line
// answering "what's the relay doing right now?". Kept as pure functions —
// separate from the commander wiring in cli.ts — so the output is unit-testable
// without a TTY, a clock, or a spawned process.

import type { QueueSummary } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
// Segment colors, chosen to echo the status palette used by the status table.
const SEGMENT_COLOR: Record<SummaryKey, string> = {
  waiting: "\x1b[33m", // yellow  (waiting_for_reset)
  active: "\x1b[36m", // cyan    (queued + resuming, in the pipeline)
  done: "\x1b[32m", // green   (completed)
  failed: "\x1b[31m", // red     (failed)
  cancelled: "\x1b[90m", // gray    (cancelled)
};

/** Shown when the store holds no jobs at all. */
export const EMPTY_SUMMARY = "queue empty";

/** Exit code (with `--exit-code`) when nothing is pending: all jobs terminal, or the queue is empty. */
export const SUMMARY_EXIT_IDLE = 0;
/** Exit code (with `--exit-code`) when work is still pending: something is queued, resuming, or waiting for a reset. */
export const SUMMARY_EXIT_PENDING = 3;

export type SummaryKey = "waiting" | "active" | "done" | "failed" | "cancelled";

export interface SummarySegment {
  key: SummaryKey;
  count: number;
  label: string;
}

/**
 * Collapse the six lifecycle statuses into the five glanceable buckets the
 * one-liner shows, in a fixed display order. `active` folds `queued` + `resuming`
 * (both in-flight through the relay). Every bucket is always computed; callers
 * decide whether to drop the zero-count ones. Pure: derived only from the counts.
 */
export function computeSummarySegments(summary: QueueSummary): SummarySegment[] {
  const s = summary.byStatus;
  return [
    { key: "waiting", count: s.waiting_for_reset, label: "waiting" },
    { key: "active", count: s.queued + s.resuming, label: "active" },
    { key: "done", count: s.completed, label: "done" },
    { key: "failed", count: s.failed, label: "failed" },
    { key: "cancelled", count: s.cancelled, label: "cancelled" },
  ];
}

/** True when the queue still has work the relay is (or will be) acting on. */
export function hasPendingWork(summary: QueueSummary): boolean {
  const s = summary.byStatus;
  return s.waiting_for_reset + s.queued + s.resuming > 0;
}

/**
 * The compact one-line overview. Only non-zero buckets are shown (so an idle
 * queue stays short), joined by " · ". When a job is waiting for a reset, a
 * trailing "next reset in <countdown>" reuses `formatCountdown` so the wording
 * matches the status table exactly ("due now"/"12m"/"1h 3m"/"2d 4h"). An empty
 * store renders {@link EMPTY_SUMMARY}. Pure: no ambient clock unless `now` is omitted.
 */
export function renderSummary(summary: QueueSummary, options: { now?: number; color?: boolean } = {}): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  if (summary.total === 0) return EMPTY_SUMMARY;

  const paint = (key: SummaryKey, text: string): string => (color ? `${SEGMENT_COLOR[key]}${text}${RESET}` : text);
  const dim = (text: string): string => (color ? `${DIM}${text}${RESET}` : text);

  const parts = computeSummarySegments(summary)
    .filter((seg) => seg.count > 0)
    .map((seg) => paint(seg.key, `${seg.count} ${seg.label}`));

  // total could be all-cancelled/done etc. with no shown segments only if every
  // count is zero, which `total === 0` already caught — so `parts` is non-empty here.
  let line = parts.join(" · ");

  if (summary.byStatus.waiting_for_reset > 0 && summary.nextResetAt) {
    const countdown = formatCountdown(summary.nextResetAt, now);
    line += ` · ${dim(countdown === "due now" ? "next reset due now" : `next reset in ${countdown}`)}`;
  }

  return line;
}

/**
 * Machine-readable form for `--json` (scripts/jq): the raw queue summary plus a
 * derived `pending` flag, wrapped in the same `{storePath, generatedAt, …}`
 * envelope the other read commands use.
 */
export function renderSummaryJson(
  summary: QueueSummary,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify({ storePath, generatedAt, pending: hasPendingWork(summary), summary }, null, 2);
}
