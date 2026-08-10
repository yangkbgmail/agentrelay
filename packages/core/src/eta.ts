import type { RelayJob } from "./types.js";

/**
 * "When is the whole queue caught up?" — where `next` (soonest reset) answers
 * *what resumes first* and `upcoming` lists the runway, `eta` answers the
 * complementary question: how long until the *last* waiting job has resumed and
 * there is nothing left for the relay to wait on. That's the **latest** reset
 * time among the jobs the scheduler still has to pick up. Computed purely from
 * the job list and an injected `now` (epoch ms) — no clock, no queue, no I/O —
 * so `agentrelay eta` is unit-testable end to end.
 */
export interface QueueEta {
  /** Number of `waiting_for_reset` jobs with a parseable `resetAt`. */
  waiting: number;
  /** How many of those are already past due (a tick would pick them up now). */
  dueNow: number;
  /** Soonest reset among the waiting jobs (ISO), or null when none are waiting. */
  firstResetAt: string | null;
  /** Latest reset among the waiting jobs (ISO) — the moment the queue is caught up. */
  lastResetAt: string | null;
  /**
   * Milliseconds from `now` until `lastResetAt` — how long until the queue is
   * fully caught up. Zero/negative once the last reset has already passed
   * (everything is due but the loop hasn't run yet). Null when nothing waits.
   */
  etaMs: number | null;
  /**
   * Span between the soonest and latest reset (`lastResetAt - firstResetAt`, ms)
   * — how spread out the resumptions are. Zero when a single job waits (or all
   * share a reset time). Null when nothing waits.
   */
  spanMs: number | null;
  /** True when no job is waiting for a reset — the relay has nothing pending. */
  caughtUp: boolean;
}

/**
 * The same set the scheduler's `listDue` acts on: `waiting_for_reset` jobs with
 * a parseable `resetAt`. Keeping this filter identical to `next`/`upcoming`
 * means all three surfaces agree on "what is the relay actually waiting on".
 */
function waitingResets(jobs: RelayJob[]): number[] {
  const resets: number[] = [];
  for (const job of jobs) {
    if (job.status !== "waiting_for_reset" || job.resetAt === null) continue;
    const ms = Date.parse(job.resetAt);
    if (!Number.isNaN(ms)) resets.push(ms);
  }
  return resets;
}

/**
 * Per-project catch-up ETA. Where {@link QueueEta} answers "when is the *whole*
 * queue caught up?", this answers the finer question a multi-project user
 * actually has — "which project is unblocked *when*?". Each entry is a project's
 * own catch-up ETA (the countdown to the latest reset among *its* waiting jobs),
 * so the rollup makes it obvious that, say, `web` frees up in an hour while
 * `infra` still has four hours to wait.
 */
export interface ProjectEta {
  /** The project name (exact `job.project`). */
  project: string;
  /** This project's catch-up ETA — always a non-`caughtUp` report (only projects with waiting jobs appear). */
  eta: QueueEta;
}

/**
 * Compute the queue's catch-up ETA: the countdown to the latest reset among all
 * waiting jobs. Returns a `caughtUp` report (all null fields) when nothing is
 * waiting for a reset — an empty queue, or only active/terminal jobs.
 */
export function computeQueueEta(jobs: RelayJob[], now: number = Date.now()): QueueEta {
  const resets = waitingResets(jobs);
  if (resets.length === 0) {
    return {
      waiting: 0,
      dueNow: 0,
      firstResetAt: null,
      lastResetAt: null,
      etaMs: null,
      spanMs: null,
      caughtUp: true,
    };
  }

  let min = resets[0];
  let max = resets[0];
  let dueNow = 0;
  for (const ms of resets) {
    if (ms < min) min = ms;
    if (ms > max) max = ms;
    if (ms <= now) dueNow += 1;
  }

  return {
    waiting: resets.length,
    dueNow,
    firstResetAt: new Date(min).toISOString(),
    lastResetAt: new Date(max).toISOString(),
    etaMs: max - now,
    spanMs: max - min,
    caughtUp: false,
  };
}

/**
 * Break the catch-up ETA down by project: one {@link ProjectEta} per project
 * that still has a job waiting for a reset, each computed by running
 * {@link computeQueueEta} over just that project's jobs — so a project's rollup
 * stays byte-for-byte consistent with what `agentrelay eta` reports for the
 * whole queue when only that project is present.
 *
 * Projects with nothing waiting (only active/terminal jobs) are omitted rather
 * than listed as a zero row, keeping the report to what a user must actually
 * keep watching. Ordered by *soonest caught up first* (earliest `lastResetAt`),
 * with the project name as a deterministic tiebreak — so the top of the list is
 * always the next project to free up. Pure: no clock or I/O beyond the injected
 * `now`, mirroring `computeQueueEta`.
 */
export function computeEtaByProject(jobs: RelayJob[], now: number = Date.now()): ProjectEta[] {
  // Group jobs by project, preserving first-seen order (only relevant before the
  // final sort, which is fully deterministic on its own).
  const byProject = new Map<string, RelayJob[]>();
  for (const job of jobs) {
    const bucket = byProject.get(job.project);
    if (bucket) bucket.push(job);
    else byProject.set(job.project, [job]);
  }

  const rows: ProjectEta[] = [];
  for (const [project, projectJobs] of byProject) {
    const eta = computeQueueEta(projectJobs, now);
    // Skip projects with nothing waiting — the rollup is about what's still pending.
    if (eta.caughtUp) continue;
    rows.push({ project, eta });
  }

  rows.sort((a, b) => {
    const la = Date.parse(a.eta.lastResetAt as string);
    const lb = Date.parse(b.eta.lastResetAt as string);
    if (la !== lb) return la - lb;
    if (a.project === b.project) return 0;
    return a.project < b.project ? -1 : 1;
  });

  return rows;
}
