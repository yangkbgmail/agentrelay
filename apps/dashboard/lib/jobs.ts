import { readFileSync } from "node:fs";
import type { HeartbeatFacts, QueueSummary, RelayJob, ResumeLoopStatus } from "@agentrelay/core";
import {
  ACTIVE_STATUSES,
  daemonHeartbeatPath,
  defaultStorePath,
  heartbeatStaleAfterMs,
  parseDaemonHeartbeat,
  RelayQueue,
  resumeLoopStatus,
  summarizeJobs,
} from "@agentrelay/core";

export interface JobsSnapshot {
  storePath: string;
  generatedAt: string;
  jobs: RelayJob[];
  summary: QueueSummary;
  /**
   * Liveness of the resume loop (daemon/tick) that actually auto-resumes jobs.
   * Lets the UI answer "will my waiting jobs get picked up?" — the #1 silent
   * failure is a waiting queue with nothing running to drain it.
   */
  resumeLoop: ResumeLoopStatus;
}

/**
 * Reads the daemon/tick heartbeat that lives next to the job store, diffing its
 * last tick against `nowMs`. This is the app-layer I/O half (filesystem + clock);
 * the staleness rule and the pure schema live in `@agentrelay/core`, mirroring
 * how the CLI's `doctor` gathers the same facts. Never throws — a missing or
 * garbled heartbeat reads as "absent".
 */
function readHeartbeatFacts(storePath: string, nowMs: number): HeartbeatFacts {
  let raw: string;
  try {
    raw = readFileSync(daemonHeartbeatPath(storePath), "utf8");
  } catch {
    return { present: false };
  }
  const hb = parseDaemonHeartbeat(raw);
  if (!hb) return { present: false };
  const lastTick = Date.parse(hb.lastTickAt);
  if (Number.isNaN(lastTick)) return { present: false };
  return {
    present: true,
    mode: hb.mode,
    pid: hb.pid,
    ageMs: Math.max(0, nowMs - lastTick),
    staleAfterMs: heartbeatStaleAfterMs(hb.mode, hb.pollIntervalMs),
  };
}

/**
 * Reads the shared JSON job store from disk. This is the dashboard's whole
 * "backend": the API route calls this on every poll, so the page always
 * reflects what the CLI/daemon last wrote (no separate server, no cache). The
 * snapshot also carries the resume-loop liveness so the page can warn when jobs
 * are waiting but nothing is running to resume them.
 */
export function readJobsSnapshot(storePath: string = defaultStorePath()): JobsSnapshot {
  const queue = new RelayQueue(storePath);
  const jobs = queue.listAll();
  queue.close();
  const summary = summarizeJobs(jobs);
  const nowMs = Date.now();
  // Jobs that need a live resume loop to progress (queued/waiting_for_reset/resuming).
  const waitingCount = ACTIVE_STATUSES.reduce((sum, status) => sum + summary.byStatus[status], 0);
  return {
    storePath,
    generatedAt: new Date(nowMs).toISOString(),
    jobs,
    summary,
    resumeLoop: resumeLoopStatus(readHeartbeatFacts(storePath, nowMs), waitingCount),
  };
}
