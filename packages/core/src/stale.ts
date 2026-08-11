import type { JobStatus, RelayJob } from "./types.js";

/**
 * The non-terminal, non-waiting statuses a job can get *wedged* in. The
 * scheduler only ever acts on `waiting_for_reset` jobs (see `queue.listDue`):
 * it pulls one, flips it to `resuming`, spawns the agent, then moves it to a
 * terminal state or re-parks it at `waiting_for_reset`. If the daemon is killed
 * (crash, SIGKILL, machine reboot) *mid-resume*, or a `queued` job never gets
 * parked, the job is left in `resuming`/`queued` — states `listDue` will never
 * pick up again. Nothing self-heals it, and `overdue` (which only inspects
 * `waiting_for_reset`) can't see it either. `stale` is the command that does.
 */
export const STALE_STATUSES: readonly JobStatus[] = ["resuming", "queued"];

/**
 * One job wedged in a non-terminal, non-waiting state for longer than the grace
 * window — i.e. a resume that started but never finished, or a freshly-created
 * job that was never parked. Computed purely from the job list and an injected
 * `now` (epoch ms) — no clock, no queue, no I/O — so `agentrelay stale` is
 * unit-testable end to end.
 */
export interface StaleEntry {
  /** The wedged job this row describes. */
  job: RelayJob;
  /** How long the job has sat unchanged (now − updatedAt), in ms (> graceMs). */
  staleForMs: number;
}

/**
 * The set of jobs that are silently stuck: `resuming`/`queued` jobs whose
 * `updatedAt` is further in the past than `graceMs`. Where `overdue` answers
 * "what should already be running but isn't?" for the *waiting* set, `stale`
 * answers the complementary, scarier question — "what got wedged half-way and
 * will never move on its own?". A healthy relay keeps this empty; a populated
 * report almost always means a daemon died mid-resume and left an orphan.
 */
export interface StaleReport {
  /** Wedged rows, most-stale first. Trimmed to `limit` when one was given. */
  entries: StaleEntry[];
  /** Total wedged jobs before any `limit` trim. */
  totalStale: number;
  /** How many wedged jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The grace window applied, in ms (jobs touched within it are not flagged). */
  graceMs: number;
  /** The worst single stale span in ms (0 when nothing is stale). */
  maxStaleForMs: number;
  /** Count of wedged jobs by status, so callers can tell orphans from unparked. */
  byStatus: Record<string, number>;
}

/** Options for {@link buildStaleReport}. */
export interface StaleOptions {
  /**
   * Only flag jobs whose last update was more than this many ms ago. Guards
   * against false alarms for a resume that is legitimately in flight right now.
   * Defaults to 0 (any wedged-status job counts). Negative/non-finite values
   * are treated as 0.
   */
  graceMs?: number;
  /** Show at most this many entries; totals still count them all. */
  limit?: number;
}

/**
 * Order two stale jobs worst-first: the one that has sat unchanged longest
 * (oldest `updatedAt`) comes first, then oldest `createdAt`, then id — fully
 * deterministic even when two jobs share an `updatedAt`. Mirrors `overdue`'s
 * ranking so the most-wedged job is always at the top where it belongs.
 */
function compareStale(a: RelayJob, b: RelayJob): number {
  const ua = Date.parse(a.updatedAt);
  const ub = Date.parse(b.updatedAt);
  // Earlier updatedAt = longer wedged = should sort first.
  if (ua !== ub) return ua - ub;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the stale report: every `resuming`/`queued` job whose `updatedAt` is
 * more than `graceMs` in the past, ranked most-stale first. This is the exact
 * complement of {@link buildOverdueReport}'s `waiting_for_reset` set, so
 * together the two commands cover every non-terminal status the scheduler could
 * leave behind.
 *
 * `limit` (a positive integer) trims the returned `entries`, but
 * `totalStale`/`maxStaleForMs`/`byStatus` still reflect the full set so callers
 * can honestly report "N more not shown".
 */
export function buildStaleReport(jobs: RelayJob[], now: number = Date.now(), options: StaleOptions = {}): StaleReport {
  const graceMs = Number.isFinite(options.graceMs) && (options.graceMs as number) > 0 ? (options.graceMs as number) : 0;

  const stale = jobs
    .filter((job) => {
      if (!STALE_STATUSES.includes(job.status)) return false;
      const updatedMs = Date.parse(job.updatedAt);
      if (Number.isNaN(updatedMs)) return false;
      return now - updatedMs > graceMs;
    })
    .sort(compareStale);

  const totalStale = stale.length;
  const { limit } = options;
  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? stale.slice(0, limit) : stale;

  const entries: StaleEntry[] = capped.map((job) => ({
    job,
    staleForMs: now - Date.parse(job.updatedAt),
  }));

  const maxStaleForMs = totalStale > 0 ? now - Date.parse(stale[0].updatedAt) : 0;

  const byStatus: Record<string, number> = {};
  for (const job of stale) {
    byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
  }

  return {
    entries,
    totalStale,
    hidden: totalStale - entries.length,
    graceMs,
    maxStaleForMs,
    byStatus,
  };
}
