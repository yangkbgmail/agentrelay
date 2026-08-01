// Rendering for `agentrelay upcoming` — a forward-looking timeline of the jobs
// the relay will resume, soonest first, each with a live countdown. Where
// `next` surfaces the single most imminent resume and `status` dumps the whole
// queue in creation order, `upcoming` answers "what's the runway?": what
// resumes next, what's queued behind it, and when each lands. Kept as pure
// functions (separate from the commander wiring) so the output is testable
// without a TTY, a clock, or a spawned process.

import type { UpcomingTimeline } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no job is waiting for a reset (empty queue or only active/terminal jobs). */
export const NO_UPCOMING_MESSAGE = "No jobs waiting for a reset.";

/**
 * Human-friendly multi-line table for the upcoming timeline: one row per
 * waiting job (position, short id, project, countdown, absolute reset time),
 * a header, and a footer summarizing totals and how many are hidden by a
 * `--limit`. Reuses `formatCountdown` so "due now"/"1h 3m"/"2d 4h" match the
 * `status`/`next` output exactly. Pure: no ambient clock unless `now` is
 * omitted.
 */
export function renderUpcoming(
  timeline: UpcomingTimeline,
  options: { now?: number; color?: boolean; scopeNote?: string } = {}
): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (timeline.entries.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    return NO_UPCOMING_MESSAGE + note;
  }

  const projWidth = Math.min(28, Math.max(7, ...timeline.entries.map((e) => e.job.project.length)));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(b(`${pad("#", 3)}  ${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("RESUMES IN", 12)}  RESET AT`));

  for (const entry of timeline.entries) {
    const pos = pad(String(entry.position), 3);
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const countdown = entry.due ? "due now" : formatCountdown(entry.job.resetAt, now);
    lines.push(`${pos}  ${b(id)}  ${project}  ${pad(countdown, 12)}  ${d(entry.job.resetAt ?? "-")}`);
  }

  lines.push("");
  lines.push(d(footer(timeline)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full timeline —
 * entries plus the honest totals (`totalWaiting`/`hidden`/`dueNow`).
 */
export function renderUpcomingJson(input: {
  storePath: string;
  generatedAt?: string;
  scope?: Record<string, unknown>;
  timeline: UpcomingTimeline;
}): string {
  return JSON.stringify(
    {
      storePath: input.storePath,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      scope: input.scope,
      timeline: input.timeline,
    },
    null,
    2
  );
}

/**
 * One frame of the live `--watch` view: a title/meta header block plus the
 * colored timeline. Separated out (like `status`'s `renderWatchFrame`) so the
 * watch loop in cli.ts only has to clear the screen and print this. Pure: `now`
 * is injectable so the countdowns and timestamp are deterministic in tests.
 */
export function renderUpcomingWatchFrame(input: {
  timeline: UpcomingTimeline;
  storePath: string;
  intervalMs: number;
  now?: number;
  scopeNote?: string;
}): string {
  const now = input.now ?? Date.now();
  const stamp = new Date(now).toISOString().replace("T", " ").slice(0, 19);
  const title = `${BOLD}agentrelay upcoming${RESET} ${DIM}(live, every ${Math.round(
    input.intervalMs / 1000
  )}s — Ctrl-C to exit)${RESET}`;
  const meta = `${DIM}${stamp}Z · ${input.storePath}${RESET}`;
  const table = renderUpcoming(input.timeline, { now, color: true, scopeNote: input.scopeNote });
  return [title, meta, "", table].join("\n");
}

function footer(timeline: UpcomingTimeline): string {
  const jobWord = timeline.totalWaiting === 1 ? "job" : "jobs";
  const parts = [`${timeline.totalWaiting} ${jobWord} waiting`];
  if (timeline.dueNow > 0) parts.push(`${timeline.dueNow} due now`);
  if (timeline.hidden > 0) parts.push(`${timeline.hidden} more not shown`);
  return parts.join(" · ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
