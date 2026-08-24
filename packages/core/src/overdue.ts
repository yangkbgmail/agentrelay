import type { RelayJob } from "./types.js";

/**
 * One `waiting_for_reset` job whose reset time has already passed by more than
 * the grace window — i.e. a scheduler tick *should* have resumed it by now but
 * apparently hasn't. Computed purely from the job list and an injected `now`
 * (epoch ms) — no clock, no queue, no I/O — so `agentrelay overdue` is
 * unit-testable end to end.
 */
export interface OverdueEntry {
  /** The stuck waiting job this row describes. */
  job: RelayJob;
  /**
   * How long the job has been due-and-unresumed, in ms. For a job with a
   * placeable reset this is `now - resetAt` (always `> graceMs`). For an
   * {@link OverdueEntry.unschedulable} job — a non-null but *unparseable*
   * `resetAt` that {@link isJobDue} treats as due on every tick — there is no
   * reset instant to measure from, so it is measured from when the job was
   * parked (`updatedAt`, falling back to `createdAt`): "how long it has been
   * stuck waiting". `0` only when neither timestamp parses.
   */
  overdueByMs: number;
  /**
   * True when the job's `resetAt` is present but *unparseable* (e.g. a malformed
   * date that slipped in via an imported dump or a hand-edited store). The
   * scheduler's {@link isJobDue} treats such a reset as due **now** on every
   * tick, so the job is stuck-and-due exactly like an overdue one — yet its
   * reset can't be placed on the timeline. These are ranked ahead of every
   * timeline-placed job because they are the most concerning: a healthy relay
   * resumes them immediately, so their lingering means the resume loop is down
   * *and* the store holds a malformed reset the relay can't schedule.
   */
  unschedulable: boolean;
}

/**
 * The set of resumes the relay has fallen behind on: `waiting_for_reset` jobs
 * whose `resetAt` is further in the past than `graceMs`. Where `upcoming` shows
 * the forward runway and `next` the single next move, `overdue` answers the
 * opposite, diagnostic question — "what should already be running but isn't?".
 * A non-empty report almost always means the resume loop (daemon/tick) is down,
 * or the agent binary can't spawn; a healthy relay keeps this empty.
 */
export interface OverdueReport {
  /** Overdue rows, most-overdue first. Trimmed to `limit` when one was given. */
  entries: OverdueEntry[];
  /** Total overdue jobs before any `limit` trim. */
  totalOverdue: number;
  /**
   * How many of the overdue jobs (full set, before any `limit` trim) have an
   * unschedulable reset — a non-null but unparseable `resetAt` the scheduler
   * treats as due every tick (see {@link OverdueEntry.unschedulable}). `0` in a
   * healthy store; a positive value points at store corruption the relay can't
   * schedule a real wait for.
   */
  unschedulable: number;
  /** How many overdue jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The grace window applied, in ms (jobs due within it are not yet overdue). */
  graceMs: number;
  /** The worst single overdue span in ms (0 when nothing is overdue). */
  maxOverdueByMs: number;
}

/** Options for {@link buildOverdueReport}. */
export interface OverdueOptions {
  /**
   * Only flag jobs whose reset passed more than this many ms ago. Guards
   * against false alarms for jobs that just came due within a poll cycle or
   * two. Defaults to 0 (any past-due waiting job counts). Negative/non-finite
   * values are treated as 0.
   */
  graceMs?: number;
  /** Show at most this many entries; totals still count them all. */
  limit?: number;
}

/** A scored overdue candidate: the job, its computed span, whether its reset is
 *  unschedulable, and the key it sorts by (earlier = more overdue = first). */
interface OverdueRow {
  job: RelayJob;
  overdueByMs: number;
  unschedulable: boolean;
  /** Sort position: a placeable reset's epoch ms, or `-Infinity` for an
   *  unschedulable job so it ranks ahead of every timeline-placed one. */
  sortKey: number;
}

/**
 * When a waiting job's reset can't be placed on the timeline, "how long overdue"
 * has no reset instant to measure from, so we measure staleness from when the
 * job was parked: `updatedAt` (the last status change, i.e. when it entered
 * `waiting_for_reset`), falling back to `createdAt`. Returns `null` only when
 * neither timestamp parses — a pathological store where even the lifecycle
 * timestamps are corrupt.
 */
function parkedSinceMs(job: RelayJob): number | null {
  const updated = Date.parse(job.updatedAt);
  if (!Number.isNaN(updated)) return updated;
  const created = Date.parse(job.createdAt);
  return Number.isNaN(created) ? null : created;
}

/**
 * Order two overdue rows worst-first: earlier `sortKey` (longer overdue, with
 * unschedulable jobs pinned to the front) comes first, then oldest `createdAt`,
 * then id — fully deterministic even when two jobs share a reset time.
 * Compared with explicit `<`/`>` (never subtraction) so the `-Infinity` sort key
 * two unschedulable jobs share doesn't produce `NaN`.
 */
function compareOverdue(a: OverdueRow, b: OverdueRow): number {
  if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
  if (a.job.createdAt !== b.job.createdAt) return a.job.createdAt < b.job.createdAt ? -1 : 1;
  if (a.job.id === b.job.id) return 0;
  return a.job.id < b.job.id ? -1 : 1;
}

/**
 * Build the overdue report: every `waiting_for_reset` job the scheduler's
 * `listDue` would pick up but that isn't being resumed, ranked most-overdue
 * first. This reads exactly the set {@link isJobDue} acts on — including a job
 * whose `resetAt` is present but *unparseable*, which `listDue` treats as due
 * every tick (see the `unschedulable` flag on {@link OverdueEntry}). Those
 * unschedulable jobs are ranked ahead of every placeable one and their span is
 * measured from when they were parked. A `null` `resetAt` is still excluded (the
 * job isn't genuinely parked on a reset), matching `isJobDue`. So a populated
 * report is a faithful "the daemon has these ready but isn't running them"
 * signal rather than a re-derivation of due logic.
 *
 * `limit` (a positive integer) trims the returned `entries`, but
 * `totalOverdue`/`maxOverdueByMs` still reflect the full set so callers can
 * honestly report "N more not shown".
 */
export function buildOverdueReport(
  jobs: RelayJob[],
  now: number = Date.now(),
  options: OverdueOptions = {}
): OverdueReport {
  const graceMs = Number.isFinite(options.graceMs) && (options.graceMs as number) > 0 ? (options.graceMs as number) : 0;

  const rows: OverdueRow[] = [];
  for (const job of jobs) {
    if (job.status !== "waiting_for_reset" || job.resetAt === null) continue;
    const resetMs = Date.parse(job.resetAt);
    if (Number.isNaN(resetMs)) {
      // Unschedulable reset: due-now every tick per `isJobDue`. Measure staleness
      // from when it was parked; grace still protects a *just*-parked job so a
      // fresh corrupt import isn't flagged before a tick could act. When even the
      // parked time is unreadable we surface it anyway (better than hiding a
      // genuinely stuck job) with a 0 span.
      const parked = parkedSinceMs(job);
      const staleMs = parked === null ? 0 : now - parked;
      if (parked !== null && !(staleMs > graceMs)) continue;
      rows.push({ job, overdueByMs: Math.max(0, staleMs), unschedulable: true, sortKey: Number.NEGATIVE_INFINITY });
    } else {
      if (!(now - resetMs > graceMs)) continue;
      rows.push({ job, overdueByMs: now - resetMs, unschedulable: false, sortKey: resetMs });
    }
  }
  rows.sort(compareOverdue);

  const totalOverdue = rows.length;
  const unschedulable = rows.reduce((count, row) => count + (row.unschedulable ? 1 : 0), 0);
  // Honest across both kinds: the longest span wins regardless of sort position
  // (an unschedulable job ranks first but may have a shorter parked-since span
  // than a very-overdue placeable one).
  const maxOverdueByMs = rows.reduce((max, row) => (row.overdueByMs > max ? row.overdueByMs : max), 0);

  const { limit } = options;
  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? rows.slice(0, limit) : rows;

  const entries: OverdueEntry[] = capped.map((row) => ({
    job: row.job,
    overdueByMs: row.overdueByMs,
    unschedulable: row.unschedulable,
  }));

  return {
    entries,
    totalOverdue,
    unschedulable,
    hidden: totalOverdue - entries.length,
    graceMs,
    maxOverdueByMs,
  };
}
