import { readFileSync } from "node:fs";
import type {
  HeartbeatStatus,
  ProjectsSummary,
  QueueSummary,
  RelayJob,
  RelayStats,
  ToolsSummary,
} from "@agentrelay/core";
import {
  computeStats,
  countActiveJobs,
  daemonHeartbeatPath,
  defaultStorePath,
  evaluateHeartbeat,
  parseDaemonHeartbeat,
  RelayQueue,
  summarizeJobs,
  summarizeProjects,
  summarizeTools,
} from "@agentrelay/core";

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
   * Headline relay metrics (mirror of `agentrelay stats`): success rate, retry
   * counts, and the resolution-time distribution (how long the relay babysat
   * jobs before they resolved). Reuses core's `computeStats`, so the dashboard's
   * effectiveness numbers never drift from the CLI. The dashboard renders the
   * resolution-time card only when `stats.timing.resolvedCount > 0`.
   */
  stats: RelayStats;
  /**
   * Liveness of the resume loop (daemon/tick), so the dashboard can surface the
   * #1 silent failure: jobs queued to resume with nothing running to resume them.
   */
  heartbeat: HeartbeatStatus;
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
    stats: computeStats(jobs),
    heartbeat: readHeartbeatStatus(storePath, jobs, nowMs),
  };
}
