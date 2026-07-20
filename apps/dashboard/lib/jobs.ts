import { readFileSync } from "node:fs";
import type { HeartbeatFacts, QueueSummary, RelayJob, ResumeLoopStatus } from "@agentrelay/core";
import {
  classifyResumeLoop,
  countActiveJobs,
  daemonHeartbeatPath,
  defaultStorePath,
  heartbeatStaleAfterMs,
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
   * Whether a resume loop (daemon/tick) is actually running — the same signal
   * `agentrelay doctor` surfaces, cross-referenced against how many jobs are
   * waiting. This is the #1 "why isn't anything resuming?" answer, so the
   * dashboard shows it prominently instead of leaving users guessing.
   */
  resumeLoop: ResumeLoopStatus;
}

/**
 * Read and judge the daemon heartbeat file that sits next to the job store.
 * Mirrors the CLI's `readHeartbeatFacts`: this app owns its filesystem + clock
 * I/O while the staleness rule and shape live in `@agentrelay/core`. Never
 * throws — a missing or garbled heartbeat simply reads as "absent".
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
 * reflects what the CLI/daemon last wrote (no separate server, no cache).
 */
export function readJobsSnapshot(storePath: string = defaultStorePath()): JobsSnapshot {
  const queue = new RelayQueue(storePath);
  const jobs = queue.listAll();
  queue.close();
  const nowMs = Date.now();
  const resumeLoop = classifyResumeLoop(readHeartbeatFacts(storePath, nowMs), countActiveJobs(jobs));
  return {
    storePath,
    generatedAt: new Date(nowMs).toISOString(),
    jobs,
    summary: summarizeJobs(jobs),
    resumeLoop,
  };
}
