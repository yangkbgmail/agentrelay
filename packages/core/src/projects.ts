import { ACTIVE_STATUSES } from "./stats.js";
import type { JobStatus, RelayJob } from "./types.js";

/**
 * Per-project rollup for `agentrelay projects`. The whole `--project` filter
 * ecosystem (status/stats/export/cancel/retry/metrics/patterns/errors) keys off
 * these labels, but until now nothing let you *discover* which project labels
 * actually exist in the store, or see at a glance which one has work pending.
 * This fills that gap: one row per distinct `job.project`, with the counts and
 * timing a maintainer needs to decide where to look next.
 */
export interface ProjectBreakdown {
  /** The project label (from `job.project`; `run --project` or the cwd default). */
  project: string;
  /** Total jobs carrying this label (within any scope the caller applied). */
  total: number;
  /** Jobs still in-flight: queued + waiting_for_reset + resuming. */
  active: number;
  /** Jobs in a terminal state: completed + failed + cancelled. */
  terminal: number;
  /** Jobs specifically parked waiting for a rate-limit reset. */
  waiting: number;
  /**
   * Earliest `resetAt` (ISO) among this project's `waiting_for_reset` jobs, or
   * null when none wait. Lets you spot which project resumes soonest.
   */
  nextResetAt: string | null;
  /**
   * The most recent `updatedAt` (ISO) across this project's jobs, or null when
   * no job has a usable timestamp — a rough "last touched" marker.
   */
  lastActivityAt: string | null;
}

/**
 * Fleet-wide project index: total jobs considered, the number of distinct
 * project labels, and the per-project breakdown ranked so the project with the
 * most pending work floats to the top.
 */
export interface ProjectsSummary {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Number of distinct project labels. */
  projectCount: number;
  /** Per-project rows, ranked by active desc, then total desc, then name asc. */
  projects: ProjectBreakdown[];
}

const ACTIVE_SET = new Set<JobStatus>(ACTIVE_STATUSES);

/**
 * Groups a job list by `job.project` into a per-project breakdown for
 * `agentrelay projects`. Pure and non-mutating: no I/O, no ambient clock. ISO
 * timestamps are compared lexically (they sort chronologically), matching how
 * `summarizeJobs` already picks the earliest `resetAt`; a missing/empty
 * `resetAt` or `updatedAt` simply doesn't participate in the min/max.
 *
 * Rows are ranked by `active` (desc) so a maintainer sees where work is pending
 * first, then by `total` (desc), then by project name (asc) for a stable order.
 */
export function summarizeProjects(jobs: RelayJob[]): ProjectsSummary {
  const buckets = new Map<string, ProjectBreakdown>();

  for (const job of jobs) {
    const project = job.project;
    let row = buckets.get(project);
    if (!row) {
      row = {
        project,
        total: 0,
        active: 0,
        terminal: 0,
        waiting: 0,
        nextResetAt: null,
        lastActivityAt: null,
      };
      buckets.set(project, row);
    }

    row.total += 1;
    if (ACTIVE_SET.has(job.status)) row.active += 1;
    else row.terminal += 1;

    if (job.status === "waiting_for_reset") {
      row.waiting += 1;
      if (job.resetAt && (row.nextResetAt === null || job.resetAt < row.nextResetAt)) {
        row.nextResetAt = job.resetAt;
      }
    }

    if (job.updatedAt && (row.lastActivityAt === null || job.updatedAt > row.lastActivityAt)) {
      row.lastActivityAt = job.updatedAt;
    }
  }

  const projects = [...buckets.values()].sort((a, b) => {
    if (b.active !== a.active) return b.active - a.active;
    if (b.total !== a.total) return b.total - a.total;
    return a.project.localeCompare(b.project);
  });

  return {
    total: jobs.length,
    projectCount: projects.length,
    projects,
  };
}
