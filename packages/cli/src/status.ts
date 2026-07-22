// Rendering helpers for `agentrelay status` (one-shot table, live `--watch`
// TUI, and `--json`). Kept as pure functions here — separate from the
// commander wiring in cli.ts — so the exact output is unit-testable without a
// TTY, a clock, or a spawned process.

import type { JobStatus, QueueSummary, RelayJob } from "@agentrelay/core";
import { summarizeJobs } from "@agentrelay/core";

const COL = { id: 10, project: 16, status: 18, resets: 12 } as const;

const ALL_STATUSES: JobStatus[] = ["queued", "waiting_for_reset", "resuming", "completed", "failed", "cancelled"];

/** ANSI color per status, applied only when the output is going to a TTY. */
const STATUS_COLOR: Record<JobStatus, string> = {
  queued: "\x1b[36m", // cyan
  waiting_for_reset: "\x1b[33m", // yellow
  resuming: "\x1b[35m", // magenta
  completed: "\x1b[32m", // green
  failed: "\x1b[31m", // red
  cancelled: "\x1b[90m", // gray
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

export const EMPTY_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown by `status` when a `--status`/`--tool`/`--project` filter matches nothing. */
export const NO_MATCH_MESSAGE = "No jobs match the current filter.";

/** Fields `agentrelay status --sort` can order by. */
export const SORT_FIELDS = ["created", "updated", "reset", "project", "status", "attempts"] as const;
export type SortField = (typeof SORT_FIELDS)[number];

/** Lifecycle order used when sorting by status (queued → … → cancelled). */
const STATUS_ORDER: Record<JobStatus, number> = ALL_STATUSES.reduce(
  (acc, status, index) => {
    acc[status] = index;
    return acc;
  },
  {} as Record<JobStatus, number>
);

/** Compare two possibly-null ISO timestamps; nulls sort last (largest). */
function compareNullableTime(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return new Date(a).getTime() - new Date(b).getTime();
}

const COMPARATORS: Record<SortField, (a: RelayJob, b: RelayJob) => number> = {
  created: (a, b) => a.createdAt.localeCompare(b.createdAt),
  updated: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
  reset: (a, b) => compareNullableTime(a.resetAt, b.resetAt),
  project: (a, b) => a.project.localeCompare(b.project),
  status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
  attempts: (a, b) => a.attempts - b.attempts,
};

export interface JobSelection {
  /** Keep only jobs whose status is in this set (empty/undefined = all). */
  statuses?: JobStatus[];
  /** Keep only jobs whose tool is in this list (matched as raw strings). */
  tools?: string[];
  /** Keep only jobs whose project is in this list (exact match). */
  projects?: string[];
  /** Sort field. When omitted, the store's own order (newest first) is kept. */
  sort?: SortField;
  /** Reverse the final order (flips the sort, or the store order if no sort). */
  reverse?: boolean;
}

/** True when a selection would actually filter the store (any dimension set). */
export function isSelectionFiltering(selection: JobSelection): boolean {
  return Boolean(
    (selection.statuses && selection.statuses.length > 0) ||
      (selection.tools && selection.tools.length > 0) ||
      (selection.projects && selection.projects.length > 0)
  );
}

/**
 * Applies a `--status`/`--tool`/`--project` filter plus `--sort`/`--reverse` to
 * a job list. Pure and non-mutating: always returns a fresh array so callers
 * (one-shot, `--json`, live `--watch`) can share one code path. Filter
 * dimensions AND together (OR within a dimension), matching `agentrelay stats`.
 * Sorting is stable — ties keep their original store order via an index fallback.
 */
export function selectJobs(jobs: RelayJob[], selection: JobSelection = {}): RelayJob[] {
  let result: RelayJob[] = jobs;

  if (selection.statuses && selection.statuses.length > 0) {
    const wanted = new Set(selection.statuses);
    result = result.filter((job) => wanted.has(job.status));
  }

  if (selection.tools && selection.tools.length > 0) {
    const wanted = new Set(selection.tools);
    result = result.filter((job) => wanted.has(job.tool));
  }

  if (selection.projects && selection.projects.length > 0) {
    const wanted = new Set(selection.projects);
    result = result.filter((job) => wanted.has(job.project));
  }

  if (selection.sort) {
    const compare = COMPARATORS[selection.sort];
    result = result
      .map((job, index) => ({ job, index }))
      .sort((a, b) => {
        const primary = compare(a.job, b.job);
        return primary !== 0 ? primary : a.index - b.index;
      })
      .map((entry) => entry.job);
  } else if (result === jobs) {
    // No filter and no sort applied yet — copy so we never mutate the input.
    result = result.slice();
  }

  if (selection.reverse) result = result.slice().reverse();
  return result;
}

export interface RenderOptions {
  /** Injectable "now" (epoch ms) so countdowns are deterministic in tests. */
  now?: number;
  /** Emit ANSI color codes (only makes sense on a TTY). */
  color?: boolean;
  /**
   * Show at most this many rows. The summary footer still counts every job
   * passed in (the full filtered set), and a truncation note names how many
   * were hidden. Undefined / non-positive means "no cap". Applied last, after
   * any filter/sort the caller already did.
   */
  limit?: number;
}

/** True when `limit` would actually hide some of `count` rows. */
function limitTruncates(limit: number | undefined, count: number): boolean {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0 && count > limit;
}

/**
 * Human-friendly "time until reset" string. Handles the whole range the relay
 * can produce: sub-hour rate limits, multi-hour windows, and multi-day
 * backoff. Returns "due now" once the reset time has passed, and "-" when
 * there is no (or an unparseable) reset time.
 */
export function formatCountdown(resetAt: string | null, now: number = Date.now()): string {
  if (!resetAt) return "-";
  const target = new Date(resetAt).getTime();
  if (Number.isNaN(target)) return "-";
  const ms = target - now;
  if (ms <= 0) return "due now";

  const totalMinutes = Math.round(ms / 60_000);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);

  if (days > 0) return `${days}d ${hours}h`;
  if (totalHours > 0) return `${totalHours}h ${minutes}m`;
  return `${minutes}m`;
}

function colorStatus(status: JobStatus, cell: string, color: boolean): string {
  if (!color) return cell;
  return `${STATUS_COLOR[status] ?? ""}${cell}${RESET}`;
}

/** One-line summary footer, e.g. "5 jobs — waiting_for_reset:2 completed:3 · next reset in 1h 3m". */
export function summaryLine(summary: QueueSummary, now: number = Date.now()): string {
  const parts = ALL_STATUSES.filter((s) => summary.byStatus[s] > 0).map((s) => `${s}:${summary.byStatus[s]}`);
  const counts = parts.length > 0 ? parts.join(" ") : "none";
  const next = summary.nextResetAt !== null ? ` · next reset in ${formatCountdown(summary.nextResetAt, now)}` : "";
  return `${summary.total} job(s) — ${counts}${next}`;
}

/**
 * Renders the full status table (header + one row per job + summary footer) as
 * a single string. Jobs are expected already sorted (newest first) by the
 * queue. Pure: no I/O, no ambient clock unless `now` is omitted.
 */
export function renderStatusTable(jobs: RelayJob[], options: RenderOptions = {}): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  if (jobs.length === 0) return EMPTY_MESSAGE;

  const header = [
    "ID".padEnd(COL.id),
    "PROJECT".padEnd(COL.project),
    "STATUS".padEnd(COL.status),
    "RESETS IN".padEnd(COL.resets),
    "ATTEMPTS",
  ].join(" ");

  // Cap the rows we print, but keep the summary over the whole set below.
  const truncated = limitTruncates(options.limit, jobs.length);
  const shown = truncated ? jobs.slice(0, options.limit) : jobs;

  const lines = shown.map((job) => {
    const statusCell = job.status.padEnd(COL.status);
    return [
      job.id.slice(0, 8).padEnd(COL.id),
      job.project.slice(0, COL.project).padEnd(COL.project),
      colorStatus(job.status, statusCell, color),
      formatCountdown(job.resetAt, now).padEnd(COL.resets),
      String(job.attempts),
    ].join(" ");
  });

  if (truncated) {
    const hidden = jobs.length - shown.length;
    const note = `… ${hidden} more not shown (showing ${shown.length} of ${jobs.length}). Raise --limit to see more.`;
    lines.push(color ? `${DIM}${note}${RESET}` : note);
  }

  // Summary reflects every job passed in, not just the shown rows, so the
  // counts stay honest even when --limit hides some.
  const footer = summaryLine(summarizeJobs(jobs), now);
  const headerLine = color ? `${BOLD}${header}${RESET}` : header;
  const footerLine = color ? `${DIM}${footer}${RESET}` : footer;
  return [headerLine, ...lines, "", footerLine].join("\n");
}

/**
 * Machine-readable snapshot for `--json` (scripts, `jq`, other tooling). Mirrors
 * the dashboard's JobsSnapshot shape so both surfaces agree.
 */
export function renderStatusJson(
  jobs: RelayJob[],
  storePath: string,
  generatedAt: string = new Date().toISOString(),
  limit?: number
): string {
  // Summary spans the full filtered set; `jobs` is capped by --limit so the
  // emitted list matches what a table with the same flags would show. `total`
  // vs `returned` makes any truncation explicit for scripts.
  const truncated = limitTruncates(limit, jobs.length);
  const emitted = truncated ? jobs.slice(0, limit) : jobs;
  return JSON.stringify(
    {
      storePath,
      generatedAt,
      summary: summarizeJobs(jobs),
      total: jobs.length,
      returned: emitted.length,
      jobs: emitted,
    },
    null,
    2
  );
}

/**
 * One frame of the live `--watch` view: a title/header block plus the colored
 * table. Separated out so the watch loop in cli.ts only has to clear the
 * screen and print this.
 */
export function renderWatchFrame(
  jobs: RelayJob[],
  storePath: string,
  intervalMs: number,
  now: number = Date.now(),
  limit?: number,
  color = true
): string {
  const bold = color ? BOLD : "";
  const dim = color ? DIM : "";
  const reset = color ? RESET : "";
  const stamp = new Date(now).toISOString().replace("T", " ").slice(0, 19);
  const title = `${bold}agentrelay status${reset} ${dim}(live, every ${Math.round(
    intervalMs / 1000
  )}s — Ctrl-C to exit)${reset}`;
  const meta = `${dim}${stamp}Z · ${storePath}${reset}`;
  return [title, meta, "", renderStatusTable(jobs, { now, color, limit })].join("\n");
}
