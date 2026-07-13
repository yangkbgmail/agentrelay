import type { QueueSummary, RelayJob } from "@agentrelay/core";
import { defaultStorePath, RelayQueue, summarizeJobs } from "@agentrelay/core";

export interface JobsSnapshot {
  storePath: string;
  generatedAt: string;
  jobs: RelayJob[];
  summary: QueueSummary;
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
  return {
    storePath,
    generatedAt: new Date().toISOString(),
    jobs,
    summary: summarizeJobs(jobs),
  };
}
