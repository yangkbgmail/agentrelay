import type { JobStatus, RelayJob } from "./types.js";

/**
 * The *transient*, in-flight statuses a healthy relay only ever passes through
 * for seconds to a few minutes: a job is briefly `queued` before it is either
 * run or parked, and briefly `resuming` while its command is respawned. Neither
 * is a resting state. A job that sits in one of these far longer than that is
 * almost always orphaned — the classic case is a `resuming` job whose spawned
 * agent process died (crash, kill, power loss) *before* the daemon recorded a
 * `completed`/`failed` outcome, leaving a permanently half-resumed record that
 * no tick will ever touch again.
 *
 * `waiting_for_reset` is deliberately excluded: sitting idle there is by design
 * (the job is waiting for its usage window to reopen), and its pathological
 * case — the reset passed but nothing resumed — is already covered by
 * `overdue`. The terminal states (`completed`/`failed`/`cancelled`) are, by
 * definition, supposed to rest forever.
 */
export const TRANSIENT_STATUSES: readonly JobStatus[] = ["queued", "resuming"] as const;

/** Default idle window before a transient-state job is flagged stuck: 15 minutes. */
export const DEFAULT_STUCK_THRESHOLD_MS = 15 * 60_000;

/**
 * One job stuck mid-flight: parked in a transient status (see
 * {@link TRANSIENT_STATUSES}) with no `updatedAt` change for longer than the
 * threshold. `idleMs` is how long it has sat untouched.
 */
export interface StuckEntry {
  /** The stuck job this row describes. */
  job: RelayJob;
  /** Milliseconds since the job was last touched (`now − updatedAt`); always > thresholdMs. */
  idleMs: number;
}

/**
 * The set of jobs the relay appears to have abandoned mid-flight. Where
 * `overdue` answers "a reset passed but nothing resumed" (a `waiting_for_reset`
 * problem), `stuck` answers the complementary, quieter question — "a job entered
 * an in-flight state and never came out" — which `overdue` structurally cannot
 * see because those jobs have no `resetAt` in the past to key off. A healthy
 * relay keeps this empty; a populated report usually means a resume crashed
 * without recording its outcome, or the daemon died between dequeue and park.
 */
export interface StuckReport {
  /** Stuck rows, most-idle first. Trimmed to `limit` when one was given. */
  entries: StuckEntry[];
  /** Total stuck jobs before any `limit` trim. */
  totalStuck: number;
  /** How many stuck jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The idle threshold applied, in ms (jobs touched more recently aren't flagged). */
  thresholdMs: number;
  /** The worst single idle span in ms (0 when nothing is stuck). */
  maxIdleMs: number;
  /** The transient statuses actually considered, in a stable order. */
  statuses: JobStatus[];
}

/** Options for {@link buildStuckReport}. */
export interface StuckOptions {
  /**
   * Only flag jobs untouched for more than this many ms. Guards against
   * false alarms for jobs that are legitimately mid-transition within a poll
   * cycle. Defaults to {@link DEFAULT_STUCK_THRESHOLD_MS}. Negative/non-finite
   * values fall back to the default.
   */
  thresholdMs?: number;
  /** Show at most this many entries; totals still count them all. */
  limit?: number;
  /**
   * Override which statuses count as "in-flight". Defaults to
   * {@link TRANSIENT_STATUSES}. Unknown statuses are ignored; an empty or
   * all-unknown list falls back to the default set so the command never
   * silently reports nothing.
   */
  statuses?: JobStatus[];
}

/**
 * Order two stuck jobs worst-first: the one idle longest comes first, then
 * oldest `createdAt`, then id — fully deterministic even when two jobs share an
 * `updatedAt`. This puts the most-abandoned job at the top where it belongs.
 */
function compareStuck(a: RelayJob, b: RelayJob): number {
  const ua = Date.parse(a.updatedAt);
  const ub = Date.parse(b.updatedAt);
  // Earlier updatedAt = longer idle = should sort first.
  if (ua !== ub) return ua - ub;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the stuck report: every job in a transient status with a parseable
 * `updatedAt` that has sat untouched for more than `thresholdMs`, ranked
 * most-idle first.
 *
 * `limit` (a non-negative integer) trims the returned `entries`, but
 * `totalStuck`/`maxIdleMs` still reflect the full set so callers can honestly
 * report "N more not shown".
 */
export function buildStuckReport(jobs: RelayJob[], now: number = Date.now(), options: StuckOptions = {}): StuckReport {
  const thresholdMs =
    Number.isFinite(options.thresholdMs) && (options.thresholdMs as number) >= 0
      ? (options.thresholdMs as number)
      : DEFAULT_STUCK_THRESHOLD_MS;

  // Resolve the considered statuses: caller override (filtered to known transient
  // states) or the default set. An empty/all-unknown override falls back so the
  // report is never accidentally scoped to nothing.
  const overridden = options.statuses?.filter((s) => (TRANSIENT_STATUSES as readonly JobStatus[]).includes(s));
  const statuses: JobStatus[] =
    overridden && overridden.length > 0
      ? [...TRANSIENT_STATUSES].filter((s) => overridden.includes(s))
      : [...TRANSIENT_STATUSES];
  const statusSet = new Set(statuses);

  const stuck = jobs
    .filter((job) => {
      if (!statusSet.has(job.status)) return false;
      const updatedMs = Date.parse(job.updatedAt);
      if (Number.isNaN(updatedMs)) return false;
      return now - updatedMs > thresholdMs;
    })
    .sort(compareStuck);

  const totalStuck = stuck.length;
  const { limit } = options;
  const capped = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? stuck.slice(0, limit) : stuck;

  const entries: StuckEntry[] = capped.map((job) => ({
    job,
    idleMs: now - Date.parse(job.updatedAt),
  }));

  const maxIdleMs = totalStuck > 0 ? now - Date.parse(stuck[0].updatedAt) : 0;

  return {
    entries,
    totalStuck,
    hidden: totalStuck - entries.length,
    thresholdMs,
    maxIdleMs,
    statuses,
  };
}
