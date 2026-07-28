// Rendering for `agentrelay upcoming` — a bucketed, forward-looking view of the
// jobs waiting to resume, grouped into a small fixed set of time windows (due
// now / within 1 hour / within 24 hours / beyond). Where `next` surfaces the
// single most imminent resume and `status` prints a flat table, `upcoming`
// answers the planning-level question "how backed up is the relay, and when
// will it clear?" at a glance. Pure functions here (separate from the commander
// wiring in cli.ts) so the exact output is unit-testable without a store, a
// clock, or a TTY.

import type { ResumeSchedule } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Shown when the store (or scoped subset) has no jobs at all. */
export const NO_UPCOMING_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/** Shown when jobs exist but none are waiting for a reset (all active/terminal). */
export const NOTHING_WAITING_MESSAGE = "No jobs waiting to resume.";

/** Max width (chars) of a full-scale bar in the bucket histogram. */
const BAR_WIDTH = 20;

/** A proportional bar `count/max` scaled to {@link BAR_WIDTH}; ≥1 for any nonzero count. */
function bar(count: number, max: number): string {
  if (max <= 0 || count <= 0) return "";
  const filled = Math.max(1, Math.round((count / max) * BAR_WIDTH));
  return "█".repeat(filled);
}

/** Widest bucket label, so counts/bars line up in a column. */
function labelWidth(schedule: ResumeSchedule): number {
  return Math.max(...schedule.buckets.map((b) => b.label.length));
}

/**
 * Renders the resume schedule as a multi-line block: a header (total waiting +
 * overall next reset), then one row per time window (label, count, proportional
 * bar, and — for non-empty windows — the soonest reset in it). Pure: no I/O, no
 * clock unless `now` is omitted. `color` gates ANSI codes (TTY only); a
 * `scopeNote` is echoed once at the top when a filter is active.
 *
 * `hasAnyJobs` distinguishes "empty store" from "jobs exist but none waiting":
 * both yield an empty schedule, but they deserve different guidance.
 */
export function renderUpcoming(
  schedule: ResumeSchedule,
  options: { now?: number; color?: boolean; scopeNote?: string; hasAnyJobs?: boolean } = {}
): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (schedule.totalWaiting === 0) {
    if (options.scopeNote) lines.push(NO_SCOPE_MATCH_MESSAGE);
    else lines.push(options.hasAnyJobs === false ? NO_UPCOMING_MESSAGE : NOTHING_WAITING_MESSAGE);
    return lines.join("\n");
  }

  const plural = schedule.totalWaiting === 1 ? "job" : "jobs";
  let nextNote = "";
  if (schedule.nextResetAt !== null) {
    const countdown = formatCountdown(schedule.nextResetAt, now);
    // formatCountdown already reads "due now" once the reset has passed, so avoid
    // the awkward "next reset in due now".
    nextNote = d(countdown === "due now" ? " · next reset due now" : ` · next reset in ${countdown}`);
  }
  lines.push(b(`${schedule.totalWaiting} ${plural} waiting to resume`) + nextNote);
  lines.push("");

  const width = labelWidth(schedule);
  const maxCount = schedule.buckets.reduce((m, x) => Math.max(m, x.count), 0);
  for (const bucket of schedule.buckets) {
    const label = bucket.label.padEnd(width);
    const count = String(bucket.count).padStart(4);
    if (bucket.count === 0) {
      lines.push(d(`  ${label} ${count}`));
      continue;
    }
    // For every non-empty window past "due now", show the soonest reset in it so
    // the countdown is anchored to a real job, not just the window boundary.
    const soonest =
      bucket.key === "overdue" || bucket.earliestResetAt === null
        ? ""
        : d(`  soonest in ${formatCountdown(bucket.earliestResetAt, now)}`);
    lines.push(`  ${label} ${count}  ${bar(bucket.count, maxCount)}${soonest}`);
  }

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay upcoming`, mirroring the `renderNextJson`/
 * `renderPatternsJson` envelope: the resolved store path, when it was generated,
 * the optional active scope, and the full schedule. Pure: `generatedAt` is
 * injected, never read from an ambient clock here.
 */
export function renderUpcomingJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  schedule: ResumeSchedule;
}): string {
  return JSON.stringify(payload, null, 2);
}
