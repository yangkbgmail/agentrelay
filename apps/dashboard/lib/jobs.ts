import { readFileSync } from "node:fs";
import type { QueueSummary, RelayJob, ResumeLoopHealth } from "@agentrelay/core";
import {
  daemonHeartbeatPath,
  defaultStorePath,
  heartbeatLiveness,
  parseDaemonHeartbeat,
  RelayQueue,
  resolveResumeLoopHealth,
  summarizeJobs,
} from "@agentrelay/core";

export interface JobsSnapshot {
  storePath: string;
  generatedAt: string;
  jobs: RelayJob[];
  summary: QueueSummary;
  /** Whether a daemon/tick resume loop is actually alive to pick up waiting jobs. */
  resumeLoop: ResumeLoopHealth;
}

/** Jobs in a state that needs a resume loop running to make progress. */
function countActive(summary: QueueSummary): number {
  return summary.byStatus.queued + summary.byStatus.waiting_for_reset + summary.byStatus.resuming;
}

/**
 * Read the daemon heartbeat next to the store and judge resume-loop health. A
 * missing/garbled heartbeat reads as "no usable heartbeat" (never throws), so the
 * dashboard degrades to "no resume loop running" rather than erroring.
 */
function readResumeLoop(storePath: string, activeCount: number, nowMs: number): ResumeLoopHealth {
  let raw: string;
  try {
    raw = readFileSync(daemonHeartbeatPath(storePath), "utf8");
  } catch {
    return resolveResumeLoopHealth(null, activeCount);
  }
  const hb = parseDaemonHeartbeat(raw);
  const liveness = hb ? heartbeatLiveness(hb, nowMs) : null;
  return resolveResumeLoopHealth(liveness, activeCount);
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
  const summary = summarizeJobs(jobs);
  return {
    storePath,
    generatedAt: new Date().toISOString(),
    jobs,
    summary,
    resumeLoop: readResumeLoop(storePath, countActive(summary), Date.now()),
  };
}
