import type { RelayJob } from "./types.js";

/**
 * One job stranded in the in-flight `resuming` state for longer than the grace
 * window. When the scheduler picks a due job it flips it to `resuming` (bumping
 * `attempts`) and then spawns the agent command; the job only leaves `resuming`
 * once that run finishes (→ `completed`/`failed`) or hits a rate limit again
 * (→ `waiting_for_reset`). If the daemon process dies *mid-resume* — SIGKILL,
 * OOM, a crash, or the machine losing power — the job is left frozen in
 * `resuming` forever: {@link import("./queue.js").RelayQueue.listDue} only picks
 * up `waiting_for_reset` jobs, so the scheduler never touches it again, and
 * `upcoming`/`overdue`/`next` all look only at `waiting_for_reset` too, so it is
 * invisible to every timeline view. This entry surfaces exactly that silent
 * failure. Computed purely from the job list and an injected `now` (epoch ms) —
 * no clock, no queue, no I/O — so `agentrelay stuck` is unit-testable end to end.
 */
export interface StuckEntry {
  /** The job frozen in `resuming` this row describes. */
  job: RelayJob;
  /** How long the job has been in `resuming`, in ms (always > graceMs). */
  stuckForMs: number;
}

/**
 * The set of jobs stranded mid-resume: `resuming` jobs whose last update
 * (`updatedAt`, i.e. the moment they entered `resuming`) is further in the past
 * than `graceMs`. Where `overdue` catches `waiting_for_reset` jobs the loop
 * should have started, `stuck` catches jobs it *did* start but that never
 * finished — the tell-tale of a daemon that died between spawning the command
 * and recording the outcome. A resuming job cannot be re-queued
 * ({@link import("./control.js").canRequeue} rejects it) nor re-picked by
 * `listDue`, so once orphaned it is both unrecoverable and unseen until this
 * report finds it. A healthy relay keeps this empty (or fleetingly small while
 * runs are actually in progress).
 */
export interface StuckReport {
  /** Stuck rows, longest-stuck first. Trimmed to `limit` when one was given. */
  entries: StuckEntry[];
  /** Total stuck jobs before any `limit` trim. */
  totalStuck: number;
  /** How many stuck jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The grace window applied, in ms (jobs resuming for less are not flagged). */
  graceMs: number;
  /** The worst single stuck span in ms (0 when nothing is stuck). */
  maxStuckForMs: number;
}

/** Options for {@link buildStuckReport}. */
export interface StuckOptions {
  /**
   * Only flag jobs that have been `resuming` for more than this many ms. A
   * resume actively runs the agent command, which can legitimately take a
   * while, so a generous grace avoids flagging runs that are simply still in
   * progress. Defaults to 0 (any resuming job counts). Negative/non-finite
   * values are treated as 0.
   */
  graceMs?: number;
  /** Show at most this many entries; totals still count them all. */
  limit?: number;
}

/**
 * Order two stuck jobs worst-first: the one that entered `resuming` earliest
 * (has been stuck longest) comes first, then oldest `createdAt`, then id — fully
 * deterministic even when two jobs share an `updatedAt`. Mirrors the tie-break
 * `overdue`/`upcoming`/`next` use so the diagnostic commands rank consistently.
 */
function compareStuck(a: RelayJob, b: RelayJob): number {
  const ua = Date.parse(a.updatedAt);
  const ub = Date.parse(b.updatedAt);
  // Earlier updatedAt = entered `resuming` sooner = stuck longer = sort first.
  if (ua !== ub) return ua - ub;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the stuck report: every `resuming` job whose `updatedAt` (the moment it
 * entered `resuming`) is more than `graceMs` in the past, ranked longest-stuck
 * first. Jobs with a missing or unparseable `updatedAt` are skipped (they can't
 * be placed on the timeline). Pure and non-mutating.
 *
 * `limit` (a non-negative integer) trims the returned `entries`, but
 * `totalStuck`/`maxStuckForMs` still reflect the full set so callers can
 * honestly report "N more not shown".
 */
export function buildStuckReport(jobs: RelayJob[], now: number = Date.now(), options: StuckOptions = {}): StuckReport {
  const graceMs = Number.isFinite(options.graceMs) && (options.graceMs as number) > 0 ? (options.graceMs as number) : 0;

  const stuck = jobs
    .filter((job) => {
      if (job.status !== "resuming") return false;
      const updatedMs = Date.parse(job.updatedAt);
      if (Number.isNaN(updatedMs)) return false;
      return now - updatedMs > graceMs;
    })
    .sort(compareStuck);

  const totalStuck = stuck.length;
  const { limit } = options;
  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? stuck.slice(0, limit) : stuck;

  const entries: StuckEntry[] = capped.map((job) => ({
    job,
    stuckForMs: now - Date.parse(job.updatedAt),
  }));

  const maxStuckForMs = totalStuck > 0 ? now - Date.parse(stuck[0].updatedAt) : 0;

  return {
    entries,
    totalStuck,
    hidden: totalStuck - entries.length,
    graceMs,
    maxStuckForMs,
  };
}
