import type { JobStatus, RelayJob } from "./types.js";
import { isTerminalStatus } from "./wait.js";

/**
 * The three terminal outcomes a resolved job can carry. A subset of
 * {@link JobStatus} — exactly the states {@link isTerminalStatus} accepts.
 */
export type ResolvedOutcome = Extract<JobStatus, "completed" | "failed" | "cancelled">;

/**
 * One recently-resolved job in the backward-looking activity feed, plus the
 * context the CLI needs to render a row. Computed purely from the job list and
 * an injected `now` (epoch ms) — no clock, no queue, no I/O — so `agentrelay
 * recent` is unit-testable end to end.
 */
export interface RecentEntry {
  /** The resolved (terminal) job this row describes. */
  job: RelayJob;
  /** Its terminal outcome: completed, failed, or cancelled. */
  outcome: ResolvedOutcome;
  /**
   * The epoch-ms when it reached its terminal state — its parsed `updatedAt`
   * (the queue stamps this on every state change, so for a terminal job it is
   * the moment it resolved). Used to order the feed.
   */
  resolvedAtMs: number;
  /** Milliseconds from `now` back to when it resolved (>= 0). */
  resolvedAgoMs: number;
  /**
   * How long the relay looked after this job before it resolved —
   * `updatedAt - createdAt`. `null` when `createdAt` is unparseable or the span
   * is negative (clock skew), so a bad timestamp never yields a bogus duration.
   * Matches the resolution-time policy `stats` uses.
   */
  resolutionMs: number | null;
  /** 1-based position in the feed (1 = most recently resolved). */
  position: number;
}

/**
 * The backward-looking mirror of `upcoming`: the jobs the relay has already
 * resolved, most recent first. Where `next`/`upcoming`/`overdue` look forward
 * at what's waiting, `recent` answers "what did the relay just finish, and how
 * long did each take?" — a resolved-activity feed for a glance at recent work.
 */
export interface RecentActivity {
  /** Ordered rows, most-recently-resolved first. Trimmed to `limit` when one was given. */
  entries: RecentEntry[];
  /** How many jobs are resolved in total (before any `limit` trim). */
  totalResolved: number;
  /** How many resolved jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** Per-outcome counts across the full resolved set (before `limit`). */
  byOutcome: Record<ResolvedOutcome, number>;
}

/** Options for {@link buildRecentActivity}: trim depth and outcome filter. */
export interface RecentOptions {
  /** When a non-negative integer, keep only the most recent N rows. */
  limit?: number;
  /**
   * When given, keep only these outcomes (e.g. `["failed"]` for a recent-
   * failures feed). Non-terminal statuses in the list are ignored. Undefined
   * or empty means all three outcomes.
   */
  outcomes?: ResolvedOutcome[];
}

/**
 * Order two resolved jobs by which resolved most recently: latest `resolvedAtMs`
 * (parsed `updatedAt`) wins, then newest `createdAt`, then id descending — so
 * the ordering is fully deterministic even when two jobs resolved in the same
 * millisecond.
 */
function compareRecent(a: RecentEntry, b: RecentEntry): number {
  if (a.resolvedAtMs !== b.resolvedAtMs) return b.resolvedAtMs - a.resolvedAtMs;
  if (a.job.createdAt !== b.job.createdAt) return a.job.createdAt < b.job.createdAt ? 1 : -1;
  if (a.job.id === b.job.id) return 0;
  return a.job.id < b.job.id ? 1 : -1;
}

/**
 * Build the recent-activity feed: the terminal jobs (completed/failed/cancelled)
 * with a parseable `updatedAt`, sorted most-recently-resolved first. Jobs whose
 * `updatedAt` can't be parsed are dropped (they can't be placed on the timeline),
 * mirroring how `upcoming` drops jobs with an unparseable `resetAt`.
 *
 * `options.outcomes` narrows to a subset of outcomes; `options.limit` (a
 * non-negative integer) trims the returned `entries` to the newest N, but
 * `totalResolved`/`byOutcome` still reflect the full (outcome-filtered) set so
 * callers can honestly report "N more not shown".
 */
export function buildRecentActivity(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: RecentOptions = {}
): RecentActivity {
  const wanted =
    options.outcomes && options.outcomes.length > 0
      ? new Set(options.outcomes.filter((o) => isTerminalStatus(o)))
      : null;

  const resolved: RecentEntry[] = [];
  for (const job of jobs) {
    if (!isTerminalStatus(job.status)) continue;
    const outcome = job.status as ResolvedOutcome;
    if (wanted && !wanted.has(outcome)) continue;

    const resolvedAtMs = Date.parse(job.updatedAt);
    if (Number.isNaN(resolvedAtMs)) continue;

    const createdMs = Date.parse(job.createdAt);
    const span = Number.isNaN(createdMs) ? null : resolvedAtMs - createdMs;
    resolved.push({
      job,
      outcome,
      resolvedAtMs,
      resolvedAgoMs: Math.max(0, now - resolvedAtMs),
      resolutionMs: span === null || span < 0 ? null : span,
      position: 0,
    });
  }

  resolved.sort(compareRecent);

  const byOutcome: Record<ResolvedOutcome, number> = { completed: 0, failed: 0, cancelled: 0 };
  for (const entry of resolved) byOutcome[entry.outcome]++;

  const totalResolved = resolved.length;
  const capped =
    typeof options.limit === "number" && Number.isInteger(options.limit) && options.limit >= 0
      ? resolved.slice(0, options.limit)
      : resolved;

  const entries = capped.map((entry, index) => ({ ...entry, position: index + 1 }));

  return {
    entries,
    totalResolved,
    hidden: totalResolved - entries.length,
    byOutcome,
  };
}
