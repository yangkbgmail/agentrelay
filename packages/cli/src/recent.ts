// Rendering for `agentrelay recent` — a backward-looking activity feed of the
// jobs the relay has most recently touched, newest first, each with a "how long
// ago" stamp. Where `next`/`upcoming`/`overdue` all look at the *reset* axis
// (what resumes, and when), `recent` looks at the *activity* axis: what the
// relay has actually been doing lately, across every status. Kept as pure
// functions (separate from the commander wiring) so the output is testable
// without a TTY, a clock, or a spawned process.

import type { JobStatus, RecentActivity } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** ANSI color per status, applied only when the output is going to a TTY. Mirrors `status`. */
const STATUS_COLOR: Record<JobStatus, string> = {
  queued: "\x1b[36m", // cyan
  waiting_for_reset: "\x1b[33m", // yellow
  resuming: "\x1b[35m", // magenta
  completed: "\x1b[32m", // green
  failed: "\x1b[31m", // red
  cancelled: "\x1b[90m", // gray
};

/** Shown when there are no jobs at all (empty store or a filter matched nothing). */
export const NO_RECENT_MESSAGE = "No recent activity.";

/**
 * Turn an entry's age (ms since `updatedAt`) into a compact "5m 3s ago" stamp.
 * `null` (unparseable timestamp) renders "unknown"; a `formatDurationMs` that
 * bottoms out (sub-second or clock-skewed future) renders "just now" so the
 * column never shows a bare "-".
 */
function formatAge(ageMs: number | null): string {
  if (ageMs === null) return "unknown";
  const formatted = formatDurationMs(ageMs);
  if (formatted === "-" || formatted === "<1s") return "just now";
  return `${formatted} ago`;
}

/**
 * Human-friendly table for the recent-activity feed: one row per job (position,
 * short id, project, colored status, "how long ago" it was last touched), a
 * header, and a footer with totals and how many are hidden by a `--limit`.
 * Pure: no ambient clock unless `now` is omitted (the age is already baked into
 * each entry by `buildRecentActivity`, so `now` here only gates nothing — kept
 * for signature symmetry with the sibling renderers).
 */
export function renderRecent(activity: RecentActivity, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const colorStatus = (status: JobStatus, cell: string): string =>
    color ? `${STATUS_COLOR[status] ?? ""}${cell}${RESET}` : cell;

  if (activity.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    return NO_RECENT_MESSAGE + note;
  }

  const projWidth = Math.min(28, Math.max(7, ...activity.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(b(`${pad("#", 3)}  ${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("STATUS", 17)}  UPDATED`));

  for (const entry of activity.entries) {
    const pos = pad(String(entry.position), 3);
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const status = colorStatus(entry.job.status, pad(entry.job.status, 17));
    lines.push(`${pos}  ${b(id)}  ${project}  ${status}  ${d(formatAge(entry.ageMs))}`);
  }

  lines.push("");
  lines.push(d(footer(activity)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full feed — entries
 * plus the honest totals (`total`/`hidden`).
 */
export function renderRecentJson(input: {
  storePath: string;
  generatedAt?: string;
  scope?: Record<string, unknown>;
  activity: RecentActivity;
}): string {
  return JSON.stringify(
    {
      storePath: input.storePath,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      scope: input.scope,
      activity: input.activity,
    },
    null,
    2
  );
}

function footer(activity: RecentActivity): string {
  const jobWord = activity.total === 1 ? "job" : "jobs";
  const parts = [`${activity.total} ${jobWord}`];
  if (activity.hidden > 0) parts.push(`${activity.hidden} more not shown`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
