import type { JobStatus, RelayJob } from "./types.js";

export interface QueueSummary {
  total: number;
  byStatus: Record<JobStatus, number>;
  /** Earliest reset time among jobs still waiting, or null when none wait. */
  nextResetAt: string | null;
}

const ALL_STATUSES: JobStatus[] = ["queued", "waiting_for_reset", "resuming", "completed", "failed", "cancelled"];

/** Aggregates a job list into the counts the dashboard/status views render. */
export function summarizeJobs(jobs: RelayJob[]): QueueSummary {
  const byStatus = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
  let nextResetAt: string | null = null;

  for (const job of jobs) {
    byStatus[job.status] += 1;
    if (job.status === "waiting_for_reset" && job.resetAt) {
      if (nextResetAt === null || job.resetAt < nextResetAt) {
        nextResetAt = job.resetAt;
      }
    }
  }

  return { total: jobs.length, byStatus, nextResetAt };
}
