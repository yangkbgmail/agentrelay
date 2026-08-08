import { readFileSync } from "node:fs";
import type {
  HeartbeatStatus,
  HourlyActivity,
  ProjectsSummary,
  QueueSummary,
  RelayJob,
  ToolsSummary,
  WeekdayActivity,
} from "@agentrelay/core";
import {
  computeHourlyDistribution,
  computeWeekdayDistribution,
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
   * Liveness of the resume loop (daemon/tick), so the dashboard can surface the
   * #1 silent failure: jobs queued to resume with nothing running to resume them.
   */
  heartbeat: HeartbeatStatus;
  /**
   * When rate-limits cluster — a mirror of `agentrelay stats --hours`/`--weekday`
   * so the dashboard shows the same UTC hour-of-day (0–23) and day-of-week
   * (Sun–Sat) activity patterns. Reuses core's distribution functions, so it
   * never drifts from the CLI. Both are always full, zero-filled shapes.
   */
  activity: ActivitySnapshot;
}

/** Aggregate activity histograms (UTC) carried in a {@link JobsSnapshot}. */
export interface ActivitySnapshot {
  /** Jobs created per UTC hour of day (always 24 entries, hour 0–23). */
  hours: HourlyActivity[];
  /** Jobs created per UTC weekday (always 7 entries, Sun–Sat). */
  weekday: WeekdayActivity[];
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
    heartbeat: readHeartbeatStatus(storePath, jobs, nowMs),
    activity: {
      hours: computeHourlyDistribution(jobs),
      weekday: computeWeekdayDistribution(jobs),
    },
  };
}
