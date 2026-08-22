import { readFileSync } from "node:fs";
import type {
  FarFutureResetJob,
  HeartbeatStatus,
  ProjectsSummary,
  QueueSummary,
  RelayJob,
  ToolsSummary,
} from "@agentrelay/core";
import {
  buildOverdueReport,
  countActiveJobs,
  daemonHeartbeatPath,
  defaultStorePath,
  evaluateHeartbeat,
  maxResetHorizonMsFromEnv,
  parseDaemonHeartbeat,
  RelayQueue,
  selectFarFutureResets,
  summarizeJobs,
  summarizeProjects,
  summarizeTools,
} from "@agentrelay/core";

/**
 * Grace window (ms) before a due-but-not-resumed job is called *overdue* on the
 * dashboard. A `waiting_for_reset` job whose reset time just passed is picked up
 * on the resume loop's next pass, so flagging it the instant it comes due would
 * false-alarm on ordinary inter-tick lag — a 30s daemon poll, or a cron-driven
 * `tick` running every few minutes. Ten minutes sits comfortably beyond both, so
 * only jobs the loop has *genuinely* fallen behind on surface here. (The CLI's
 * `agentrelay overdue` defaults to no grace for exactness; the always-on
 * dashboard wants the quieter threshold so a healthy relay's card stays empty.)
 */
export const DASHBOARD_OVERDUE_GRACE_MS = 10 * 60_000;

/** How many overdue rows the snapshot carries (the card shows the worst few). */
const OVERDUE_LIMIT = 5;

export interface JobsSnapshot {
  storePath: string;
  generatedAt: string;
  jobs: RelayJob[];
  summary: QueueSummary;
  /**
   * Per-project rollup (mirror of `agentrelay projects`) so the dashboard can
   * show which project has work parked waiting for a reset — ranked with the most
   * pending work first. Reuses core's `summarizeProjects`, so it never drifts
   * from the CLI.
   */
  projects: ProjectsSummary;
  /**
   * Per-tool rollup (mirror of `agentrelay tools`), keyed off `job.tool`, so the
   * dashboard shows which agent CLI is rate-limited. Reuses core's
   * `summarizeTools`.
   */
  tools: ToolsSummary;
  /**
   * Liveness of the resume loop (daemon/tick), so the dashboard can surface the
   * #1 silent failure: jobs queued to resume with nothing running to resume them.
   */
  heartbeat: HeartbeatStatus;
  /**
   * Active jobs parked with an implausibly-distant reset time — a misparse (or a
   * job queued before the parser's horizon guard existed) that will sit
   * `waiting_for_reset` for days/years and never resume in a sane window. Mirror
   * of `agentrelay doctor`'s `reset-horizon` check, so the dashboard surfaces the
   * same silent-failure class the CLI does. Reuses core's `selectFarFutureResets`
   * / `maxResetHorizonMsFromEnv`, so it never drifts from `doctor`.
   */
  resetHorizon: ResetHorizonSummary;
  /**
   * `waiting_for_reset` jobs whose reset time passed more than
   * {@link DASHBOARD_OVERDUE_GRACE_MS} ago — the resume loop *should* have picked
   * them up by now but hasn't. Where the heartbeat card asks "is the loop
   * alive?", this asks the job-level question "which resumes has it fallen behind
   * on, and how far?" — a signal that fires even when the loop looks alive but
   * isn't draining (spawn failures, concurrency starvation). Mirror of
   * `agentrelay overdue`, reusing core's `buildOverdueReport` so it never drifts.
   */
  overdue: OverdueSummary;
}

/** One overdue row for the dashboard card — lean projection of a job. */
export interface OverdueJob {
  /** The job's id (enough to `agentrelay show <id>` it). */
  id: string;
  /** The job's project label, for a human-legible listing. */
  project: string;
  /** How long ago (ms) its reset time passed — always beyond the grace window. */
  overdueByMs: number;
}

/** The dashboard's view of {@link readJobsSnapshot}'s overdue check. */
export interface OverdueSummary {
  /** The worst-overdue jobs (most-behind first), capped at {@link OVERDUE_LIMIT}. */
  jobs: OverdueJob[];
  /** Total overdue jobs before the cap — drives the "+N more" line. */
  totalOverdue: number;
  /** The grace window (ms) applied — see {@link DASHBOARD_OVERDUE_GRACE_MS}. */
  graceMs: number;
}

/** The dashboard's view of {@link readJobsSnapshot}'s reset-horizon check. */
export interface ResetHorizonSummary {
  /**
   * Active jobs whose `resetAt` is beyond {@link horizonMs} from now. Empty when
   * none are, or when the guard is disabled ({@link horizonMs} is `null`).
   */
  jobs: FarFutureResetJob[];
  /**
   * The horizon (ms) judged against, or `null` when the reset-horizon guard is
   * disabled (`AGENTRELAY_MAX_RESET_HORIZON=off`) — then there's no bound to flag
   * against and the dashboard shows nothing.
   */
  horizonMs: number | null;
}

/**
 * Read the daemon/tick heartbeat that sits next to the store and judge it into a
 * {@link HeartbeatStatus}. A missing/unreadable/corrupt heartbeat file reads as
 * "no heartbeat" (absent) rather than throwing — the dashboard must render even
 * when no resume loop has ever run.
 */
function readHeartbeatStatus(storePath: string, jobs: RelayJob[], nowMs: number): HeartbeatStatus {
  let raw: string;
  try {
    raw = readFileSync(daemonHeartbeatPath(storePath), "utf8");
  } catch {
    return evaluateHeartbeat(null, { nowMs, waitingJobs: countActiveJobs(jobs) });
  }
  return evaluateHeartbeat(parseDaemonHeartbeat(raw), { nowMs, waitingJobs: countActiveJobs(jobs) });
}

/**
 * Re-checks the live queue for jobs parked with an implausibly-far reset time,
 * against the same horizon the parser/`doctor` use ({@link maxResetHorizonMsFromEnv}).
 * When the guard is disabled the horizon is `null` and no job is flagged — there's
 * no bound to judge against. Pure reuse of core's `selectFarFutureResets` keeps
 * this in lockstep with the CLI's `reset-horizon` check.
 */
function readResetHorizonSummary(jobs: RelayJob[], now: Date): ResetHorizonSummary {
  const horizonMs = maxResetHorizonMsFromEnv();
  if (horizonMs === null) return { jobs: [], horizonMs: null };
  return { jobs: selectFarFutureResets(jobs, { now, horizonMs }), horizonMs };
}

/**
 * Finds the resumes the relay has fallen behind on: `waiting_for_reset` jobs due
 * more than {@link DASHBOARD_OVERDUE_GRACE_MS} ago. Pure reuse of core's
 * `buildOverdueReport` (the same function `agentrelay overdue` runs), so the
 * dashboard and CLI agree on what "overdue" means. Capped to a handful of the
 * worst offenders for the card; `totalOverdue` keeps the honest count.
 */
function readOverdueSummary(jobs: RelayJob[], nowMs: number): OverdueSummary {
  const report = buildOverdueReport(jobs, nowMs, { graceMs: DASHBOARD_OVERDUE_GRACE_MS, limit: OVERDUE_LIMIT });
  return {
    jobs: report.entries.map((entry) => ({
      id: entry.job.id,
      project: entry.job.project,
      overdueByMs: entry.overdueByMs,
    })),
    totalOverdue: report.totalOverdue,
    graceMs: report.graceMs,
  };
}

/**
 * Reads the shared JSON job store from disk. This is the dashboard's whole
 * "backend": the API route calls this on every poll, so the page always
 * reflects what the CLI/daemon last wrote (no separate server, no cache).
 */
export function readJobsSnapshot(storePath: string = defaultStorePath()): JobsSnapshot {
  const queue = new RelayQueue(storePath);
  const jobs = queue.listAll();
  queue.close();
  const nowMs = Date.now();
  return {
    storePath,
    generatedAt: new Date(nowMs).toISOString(),
    jobs,
    summary: summarizeJobs(jobs),
    projects: summarizeProjects(jobs),
    tools: summarizeTools(jobs),
    heartbeat: readHeartbeatStatus(storePath, jobs, nowMs),
    resetHorizon: readResetHorizonSummary(jobs, new Date(nowMs)),
    overdue: readOverdueSummary(jobs, nowMs),
  };
}
