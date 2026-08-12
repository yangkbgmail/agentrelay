// Rendering for `agentrelay logs` — a reverse-chronological activity feed of the
// jobs whose state most recently changed, newest first, each distilled to a
// one-line reason (the failure, the rate-limit that parked it, or a hint of its
// last output). Where `errors` groups failures by reason, `upcoming` looks
// forward at pending resumes, and `status` lists the queue in creation order,
// `logs` answers "what has the relay been doing lately?". Kept as pure functions
// (separate from the commander wiring in cli.ts) so the exact output is
// unit-testable without a TTY, a clock, or a store.

import type { ActivityEntry, ActivityFeed, ActivityReasonKind, JobStatus } from "@agentrelay/core";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

/** ANSI color per status, applied only when writing to a TTY. Matches summary.ts. */
const STATUS_COLOR: Record<JobStatus, string> = {
  queued: "\x1b[36m", // cyan
  waiting_for_reset: "\x1b[33m", // yellow
  resuming: "\x1b[35m", // magenta
  completed: "\x1b[32m", // green
  failed: "\x1b[31m", // red
  cancelled: "\x1b[90m", // gray
};

/** ANSI color per reason kind, so a failure line reads differently from a note. */
const REASON_COLOR: Record<ActivityReasonKind, string> = {
  error: "\x1b[31m", // red
  "rate-limit": "\x1b[33m", // yellow
  output: "\x1b[2m", // dim
  none: "\x1b[2m", // dim
};

/** Shown when the store has no jobs at all. */
export const EMPTY_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a scope filter matched nothing (vs. an empty store). */
export const NO_MATCH_MESSAGE = "No jobs match the given filters.";

/** Placeholder reason text for a job that has no error/rate-limit/output yet. */
const NO_REASON_TEXT = "—";

/**
 * Human-friendly age of a past timestamp relative to `now`: "just now", "3m
 * ago", "5h ago", "2d ago", or an absolute date for anything older than ~30
 * days. `null` (an unparseable `updatedAt`) renders as "unknown". Future
 * timestamps (clock skew) clamp to "just now". Pure.
 */
export function formatAge(updatedMs: number | null, now: number): string {
  if (updatedMs === null) return "unknown";
  const delta = now - updatedMs;
  if (delta < 60_000) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days}d ago`;
  return new Date(updatedMs).toISOString().slice(0, 10);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}

function renderRow(
  entry: ActivityEntry,
  now: number,
  color: boolean,
  widths: { age: number; project: number }
): string {
  const paint = (code: string, s: string): string => (color ? `${code}${s}${RESET}` : s);

  const age = pad(formatAge(entry.updatedMs, now), widths.age);
  const status = paint(STATUS_COLOR[entry.job.status], pad(entry.job.status, 17));
  const id = entry.job.id.slice(0, 8);
  const project = pad(truncate(entry.job.project, widths.project), widths.project);
  const reasonText = entry.reason.kind === "none" ? NO_REASON_TEXT : entry.reason.text;
  const reason = paint(REASON_COLOR[entry.reason.kind], reasonText);

  return `${paint(DIM, age)}  ${status}  ${paint(BOLD, id)}  ${project}  ${reason}`;
}

/**
 * Render the activity feed as a multi-line block: a title, an optional scope
 * note, one row per job (age · status · short id · project · reason), and a
 * footer with the shown/hidden totals. Pure: no I/O, no ambient clock unless
 * `now` is omitted. `color` gates ANSI (TTY only).
 */
export function renderLogs(
  feed: ActivityFeed,
  options: { now?: number; color?: boolean; scopeNote?: string } = {}
): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);

  const lines: string[] = [];
  lines.push(b("Recent activity") + d(" (newest first)"));
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (feed.entries.length === 0) {
    lines.push("");
    lines.push(feed.total === 0 && !options.scopeNote ? EMPTY_MESSAGE : NO_MATCH_MESSAGE);
    return lines.join("\n");
  }

  const ageWidth = Math.max(9, ...feed.entries.map((e) => formatAge(e.updatedMs, now).length));
  const projectWidth = Math.min(24, Math.max(7, ...feed.entries.map((e) => e.job.project.length)));
  const widths = { age: ageWidth, project: projectWidth };

  lines.push("");
  for (const entry of feed.entries) lines.push(renderRow(entry, now, color, widths));

  lines.push("");
  const jobWord = feed.total === 1 ? "job" : "jobs";
  let footer = `${feed.shown} of ${feed.total} ${jobWord} shown`;
  if (feed.hidden > 0) footer += ` · ${feed.hidden} more not shown (raise --limit)`;
  lines.push(d(footer));

  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and a compact per-entry view
 * (id, project, tool, status, updatedAt, updatedMs, and the distilled reason) —
 * enough to reconstruct the feed without the full job records.
 */
export function renderLogsJson(input: {
  storePath: string;
  generatedAt?: string;
  scope?: Record<string, unknown>;
  feed: ActivityFeed;
}): string {
  return JSON.stringify(
    {
      storePath: input.storePath,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      scope: input.scope,
      total: input.feed.total,
      shown: input.feed.shown,
      hidden: input.feed.hidden,
      entries: input.feed.entries.map((e) => ({
        id: e.job.id,
        project: e.job.project,
        tool: e.job.tool,
        status: e.job.status,
        updatedAt: e.job.updatedAt,
        updatedMs: e.updatedMs,
        reason: e.reason,
      })),
    },
    null,
    2
  );
}
