import { readFileSync } from "node:fs";
import type { QueueSummary, RelayJob, ResumeLoopHealth } from "@agentrelay/core";
import {
  classifyResumeLoop,
  countActiveJobs,
  daemonHeartbeatPath,
  defaultStorePath,
  heartbeatFactsFrom,
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
   * Health of the resume loop (daemon/tick) that actually re-runs rate-limited
   * jobs. Derived from the heartbeat file the daemon writes next to the store,
   * cross-referenced with how many jobs are waiting — so the dashboard can warn
   * "jobs are queued but nothing is running to resume them", AgentRelay's #1
   * silent failure.
   */
  resumeLoop: ResumeLoopHealth;
}

/**
 * Read the heartbeat file next to the store and judge resume-loop health. Never
 * throws — a missing or garbled heartbeat simply reads as "absent", which is the
 * honest signal. The file read + clock live here; the classification is pure in
 * `@agentrelay/core`, mirroring how `doctor` gathers its facts.
 */
function readResumeLoop(storePath: string, jobs: RelayJob[], nowMs: number): ResumeLoopHealth {
  let raw: string | null = null;
  try {
    raw = readFileSync(daemonHeartbeatPath(storePath), "utf8");
  } catch {
    raw = null;
  }
  const facts = heartbeatFactsFrom(raw === null ? null : parseDaemonHeartbeat(raw), nowMs);
  return classifyResumeLoop(facts, countActiveJobs(jobs));
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
  const generatedAt = new Date();
  return {
    storePath,
    generatedAt: generatedAt.toISOString(),
    jobs,
    summary: summarizeJobs(jobs),
    resumeLoop: readResumeLoop(storePath, jobs, generatedAt.getTime()),
  };
}
