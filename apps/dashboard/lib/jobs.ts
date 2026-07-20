import { readFileSync } from "node:fs";
import type { HeartbeatStatus, QueueSummary, RelayJob } from "@agentrelay/core";
import {
  countActiveJobs,
  daemonHeartbeatPath,
  defaultStorePath,
  evaluateHeartbeat,
  parseDaemonHeartbeat,
  RelayQueue,
  summarizeJobs,
} from "@agentrelay/core";

export interface JobsSnapshot {
  storePath: string;
  generatedAt: string;
  jobs: RelayJob[];
  summary: QueueSummary;
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
    heartbeat: readHeartbeatStatus(storePath, jobs, nowMs),
  };
}
