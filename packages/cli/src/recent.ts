// Rendering for `agentrelay recent` — the backward-looking mirror of `upcoming`.
// While `next`/`upcoming` show the forward runway (jobs waiting to resume) and
// `overdue` the stuck ones, `recent` answers "what did the relay just finish,
// and how long did each take?": a feed of resolved jobs (completed/failed/
// cancelled), most recent first, each with the time since it resolved and how
// long the relay looked after it. Kept as pure functions (separate from the
// commander wiring) so the output is testable without a TTY, a clock, or a
// spawned process.

import type { RecentActivity, ResolvedOutcome } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** ANSI color per outcome, matching the `status` table's status coloring. */
const OUTCOME_COLOR: Record<ResolvedOutcome, string> = {
  completed: "\x1b[32m", // green
  failed: "\x1b[31m", // red
  cancelled: "\x1b[90m", // gray
};

/** Shown when no job has resolved yet (empty queue or only active jobs). */
export const NO_RECENT_MESSAGE = "No resolved jobs yet.";

/**
 * Human-friendly multi-line table for the recent feed: one row per resolved job
 * (position, short id, project, colored outcome, how long ago it resolved, how
 * long the relay looked after it), a header, and a footer summarizing totals,
 * the per-outcome split, and how many are hidden by a `--limit`. Reuses
 * `formatDurationMs` so "2h 5m"/"3d 4h" match `stats`/`overdue`. Pure: the
 * durations come precomputed in the feed, so no ambient clock is read.
 */
export function renderRecent(feed: RecentActivity, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (feed.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    return NO_RECENT_MESSAGE + note;
  }

  const projWidth = Math.min(28, Math.max(7, ...feed.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(
    b(
      `${pad("#", 3)}  ${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("OUTCOME", 9)}  ${pad(
        "RESOLVED",
        12
      )}  TOOK`
    )
  );

  for (const entry of feed.entries) {
    const pos = pad(String(entry.position), 3);
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const outcome = colorOutcome(entry.outcome, pad(entry.outcome, 9), color);
    const ago = pad(`${formatDurationMs(entry.resolvedAgoMs)} ago`, 12);
    const took = entry.resolutionMs === null ? d("-") : formatDurationMs(entry.resolutionMs);
    lines.push(`${pos}  ${b(id)}  ${project}  ${outcome}  ${ago}  ${took}`);
  }

  lines.push("");
  lines.push(d(footer(feed)));
  return lines.join("\n");
}

/**
 * One frame of the live `recent --watch` view: a title/header block (matching
 * the shape of `status`/`upcoming`/`overdue --watch`) plus the colored feed.
 * Separated out so the watch loop only has to clear the screen and print this.
 * The "resolved N ago" spans grow in place because the loop re-reads the store
 * and rebuilds the feed with a fresh `now` each pass.
 */
export function renderRecentWatchFrame(
  feed: RecentActivity,
  storePath: string,
  intervalMs: number,
  now: number = Date.now(),
  scopeNote?: string
): string {
  const stamp = new Date(now).toISOString().replace("T", " ").slice(0, 19);
  const title = `${BOLD}agentrelay recent${RESET} ${DIM}(live, every ${Math.round(
    intervalMs / 1000
  )}s — Ctrl-C to exit)${RESET}`;
  const meta = `${DIM}${stamp}Z · ${storePath}${RESET}`;
  return [title, meta, "", renderRecent(feed, { color: true, scopeNote })].join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full feed — entries
 * plus the honest totals (`totalResolved`/`hidden`/`byOutcome`).
 */
export function renderRecentJson(input: {
  storePath: string;
  generatedAt?: string;
  scope?: Record<string, unknown>;
  feed: RecentActivity;
}): string {
  return JSON.stringify(
    {
      storePath: input.storePath,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      scope: input.scope,
      feed: input.feed,
    },
    null,
    2
  );
}

function colorOutcome(outcome: ResolvedOutcome, cell: string, color: boolean): string {
  if (!color) return cell;
  return `${OUTCOME_COLOR[outcome]}${cell}${RESET}`;
}

function footer(feed: RecentActivity): string {
  const jobWord = feed.totalResolved === 1 ? "job" : "jobs";
  const parts = [`${feed.totalResolved} ${jobWord} resolved`];
  const split = (["completed", "failed", "cancelled"] as const)
    .filter((o) => feed.byOutcome[o] > 0)
    .map((o) => `${o}:${feed.byOutcome[o]}`);
  if (split.length > 0) parts.push(split.join(" "));
  if (feed.hidden > 0) parts.push(`${feed.hidden} more not shown`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
