import { readFileSync } from "node:fs";
import type { HeartbeatStatus, ProjectsSummary, QueueSummary, RelayJob, ToolsSummary } from "@agentrelay/core";
import {
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
   * Whether the store file was unreadable when this snapshot was read. The queue
   * loader moves a corrupt `jobs.json` aside and starts fresh, so without this
   * the dashboard would silently show an empty queue as if nothing were wrong —
   * hiding real data loss. When `corrupt` is true the dashboard shows a banner
   * (mirroring the CLI's stderr warning) pointing at the moved-aside backup so
   * the user can `agentrelay restore` it.
   */
  store: StoreState;
}

/** State of the store file for a single {@link JobsSnapshot} read. */
export interface StoreState {
  /** True when the store file existed but could not be parsed as a job array. */
  corrupt: boolean;
  /**
   * Where the unreadable file was moved to (`jobs.json.corrupt-<ts>`), or null
   * when the queue couldn't move it aside. Only set when `corrupt` is true.
   */
  backupPath: string | null;
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
  // Capture corruption the same way the CLI does (its `openQueue` warns on
  // stderr) so the dashboard can surface it instead of silently showing the
  // empty queue the loader falls back to.
  const store: StoreState = { corrupt: false, backupPath: null };
  const queue = new RelayQueue(storePath, {
    onCorrupt: ({ backupPath }) => {
      store.corrupt = true;
      store.backupPath = backupPath;
    },
  });
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
    store,
  };
}
