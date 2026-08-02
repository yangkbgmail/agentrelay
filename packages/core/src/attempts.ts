import type { JobStatus, RelayJob } from "./types.js";

/**
 * Statuses a job has *not* finished from — the ones from which the scheduler
 * can still spend another resume attempt. Only these can exhaust the retry
 * budget, so only these are ever flagged "at risk" below. Kept in sync with
 * the terminal set used across the queue (`completed`/`failed`/`cancelled`).
 */
const NON_TERMINAL_STATUSES: readonly JobStatus[] = ["queued", "waiting_for_reset", "resuming"];

function isNonTerminal(status: JobStatus): boolean {
  return NON_TERMINAL_STATUSES.includes(status);
}

/**
 * One job in the "resume effort" view: how many times the relay has already
 * tried to resume it, how much of the retry budget is left, and whether it is
 * close enough to exhaustion to warrant a warning. Computed purely from the
 * job list and an injected budget — no clock, no queue, no I/O — so
 * `agentrelay attempts` is unit-testable end to end.
 */
export interface AttemptEntry {
  /** The job this row describes. */
  job: RelayJob;
  /** Its persisted resume-attempt count (`job.attempts`). */
  attempts: number;
  /**
   * How many attempts remain before the retry budget is exhausted
   * (`maxAttempts - attempts`, floored at 0). `null` when the budget is
   * unlimited (`maxAttempts <= 0`) — there is no ceiling to count down to.
   */
  remaining: number | null;
  /**
   * True when this job can still burn attempts (non-terminal) *and* a finite
   * budget applies *and* `remaining <= riskThreshold`. Terminal jobs are never
   * at risk — they've already stopped, however many attempts they used.
   */
  atRisk: boolean;
}

/**
 * The "resume effort" report: which jobs the relay is working hardest to
 * complete, ranked most-attempted first, and which are about to be given up on
 * (marked `failed`) once they hit the retry budget. Where `errors` groups jobs
 * that have *already* failed and `overdue` flags jobs a dead resume loop has
 * stranded, `attempts` is the early-warning axis — it surfaces jobs still in
 * flight but circling the drain, before exhaustion turns them into failures.
 */
export interface AttemptReport {
  /** Ranked rows (only jobs with ≥1 attempt), trimmed to `limit` when given. */
  entries: AttemptEntry[];
  /** Every in-scope job, whether or not it has been retried. */
  totalJobs: number;
  /** How many in-scope jobs have at least one attempt (the full ranked set). */
  withAttempts: number;
  /** Sum of `attempts` across every in-scope job. */
  totalAttempts: number;
  /** The effective retry budget echoed back (0 means unlimited). */
  maxAttempts: number;
  /** The `remaining <= riskThreshold` bar used to flag at-risk jobs. */
  riskThreshold: number;
  /** How many jobs are at risk of exhausting the budget (full set, pre-limit). */
  atRiskCount: number;
  /** How many attempted jobs are hidden by `limit` (0 when all are shown). */
  hidden: number;
  /** The highest attempt count on any single in-scope job (0 when none). */
  maxSingleAttempts: number;
}

/** Options for {@link buildAttemptReport}. */
export interface AttemptOptions {
  /**
   * The retry budget a job may spend before the scheduler marks it `failed`
   * (see {@link isRetryExhausted} in retry.ts). `<= 0` (or non-finite) means
   * unlimited — no job is ever flagged at risk. Defaults to unlimited so the
   * report is honest when the caller doesn't know the effective policy; the
   * CLI passes the resolved `retryPolicyFromEnv().maxAttempts`.
   */
  maxAttempts?: number;
  /**
   * Flag a non-terminal job "at risk" once its `remaining` falls to this many
   * attempts or fewer. Defaults to 1 (the last attempt before exhaustion).
   * Negative/non-finite values are clamped to 0.
   */
  riskThreshold?: number;
  /** Show at most this many entries; the totals still count them all. */
  limit?: number;
}

/**
 * Order two attempted jobs most-effort-first: the one the relay has retried
 * most comes first; ties break to the at-risk job (it needs attention sooner),
 * then to non-terminal over terminal (still live), then oldest `createdAt`,
 * then id — fully deterministic even when two jobs share an attempt count.
 */
function compareEntries(a: AttemptEntry, b: AttemptEntry): number {
  if (a.attempts !== b.attempts) return b.attempts - a.attempts;
  if (a.atRisk !== b.atRisk) return a.atRisk ? -1 : 1;
  const aLive = isNonTerminal(a.job.status);
  const bLive = isNonTerminal(b.job.status);
  if (aLive !== bLive) return aLive ? -1 : 1;
  if (a.job.createdAt !== b.job.createdAt) return a.job.createdAt < b.job.createdAt ? -1 : 1;
  if (a.job.id === b.job.id) return 0;
  return a.job.id < b.job.id ? -1 : 1;
}

/**
 * Build the resume-effort report from a job list and a retry budget. Pure and
 * non-mutating: the input array is left untouched. Only jobs with at least one
 * recorded attempt appear in `entries` (a never-retried job carries no effort
 * signal), but `totalJobs`/`totalAttempts` reflect the entire in-scope set so
 * callers can honestly report coverage. Callers scope the list first
 * (by status/tool/project/time) exactly as `stats`/`overdue` do.
 *
 * `limit` (a non-negative integer) trims the returned `entries`, but
 * `withAttempts`/`atRiskCount`/`maxSingleAttempts` still reflect the full set,
 * so the CLI can print an honest "N more not shown".
 */
export function buildAttemptReport(jobs: RelayJob[], options: AttemptOptions = {}): AttemptReport {
  const maxAttempts =
    Number.isFinite(options.maxAttempts) && (options.maxAttempts as number) > 0
      ? Math.floor(options.maxAttempts as number)
      : 0;
  // Default the risk bar to 1 (warn on the last attempt) when unset; any given
  // value is floored and clamped to 0, so a negative/NaN threshold never warns.
  const riskThreshold =
    options.riskThreshold === undefined
      ? 1
      : Number.isFinite(options.riskThreshold) && (options.riskThreshold as number) > 0
        ? Math.floor(options.riskThreshold as number)
        : 0;

  let totalAttempts = 0;
  let maxSingleAttempts = 0;
  const all: AttemptEntry[] = [];

  for (const job of jobs) {
    const attempts = Number.isFinite(job.attempts) && job.attempts > 0 ? Math.floor(job.attempts) : 0;
    totalAttempts += attempts;
    if (attempts > maxSingleAttempts) maxSingleAttempts = attempts;
    if (attempts < 1) continue;

    const remaining = maxAttempts > 0 ? Math.max(0, maxAttempts - attempts) : null;
    const atRisk = remaining !== null && isNonTerminal(job.status) && remaining <= riskThreshold;
    all.push({ job, attempts, remaining, atRisk });
  }

  all.sort(compareEntries);

  const withAttempts = all.length;
  const atRiskCount = all.reduce((n, e) => n + (e.atRisk ? 1 : 0), 0);

  const { limit } = options;
  const entries = typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? all.slice(0, limit) : all;

  return {
    entries,
    totalJobs: jobs.length,
    withAttempts,
    totalAttempts,
    maxAttempts,
    riskThreshold,
    atRiskCount,
    hidden: withAttempts - entries.length,
    maxSingleAttempts,
  };
}
