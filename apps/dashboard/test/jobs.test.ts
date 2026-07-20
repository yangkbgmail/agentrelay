import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonHeartbeat } from "@agentrelay/core";
import { daemonHeartbeatPath, RelayQueue, serializeDaemonHeartbeat } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJobsSnapshot } from "../lib/jobs";

/** Write a daemon heartbeat file next to the store, with lastTickAt set N ms ago. */
function writeHeartbeat(storePath: string, ageMs: number, pollIntervalMs = 30_000): void {
  const lastTickAt = new Date(Date.now() - ageMs).toISOString();
  const hb: DaemonHeartbeat = { pid: 4321, mode: "daemon", startedAt: lastTickAt, lastTickAt, pollIntervalMs };
  writeFileSync(daemonHeartbeatPath(storePath), serializeDaemonHeartbeat(hb), "utf8");
}

describe("readJobsSnapshot", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-dashboard-test-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty snapshot when the store file does not exist yet", () => {
    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.jobs).toEqual([]);
    expect(snapshot.summary.total).toBe(0);
    expect(snapshot.summary.nextResetAt).toBeNull();
    expect(snapshot.storePath).toBe(storePath);
  });

  it("reads jobs written by the CLI-side queue and summarizes them", () => {
    const queue = new RelayQueue(storePath);
    const a = queue.enqueue({ project: "proj-a", tool: "claude-code", command: ["claude", "-p", "hi"], cwd: dir });
    queue.markWaitingForReset(a.id, "2099-01-01T00:00:00.000Z");
    const b = queue.enqueue({ project: "proj-b", tool: "generic", command: ["echo", "done"], cwd: dir });
    queue.markCompleted(b.id, "done");
    queue.close();

    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.jobs).toHaveLength(2);
    expect(snapshot.summary.byStatus.waiting_for_reset).toBe(1);
    expect(snapshot.summary.byStatus.completed).toBe(1);
    expect(snapshot.summary.nextResetAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("survives a corrupt store file instead of crashing the API route", () => {
    writeFileSync(storePath, "{ not json !!", "utf8");
    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.jobs).toEqual([]);
    expect(snapshot.summary.total).toBe(0);
  });

  it("reports an absent resume loop with no concern when nothing is waiting", () => {
    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.resumeLoop.state).toBe("absent");
    expect(snapshot.resumeLoop.concern).toBe(false);
    expect(snapshot.resumeLoop.waitingCount).toBe(0);
  });

  it("flags a concern when jobs are waiting but no heartbeat exists", () => {
    const queue = new RelayQueue(storePath);
    const a = queue.enqueue({ project: "proj-a", tool: "claude-code", command: ["claude", "-p", "hi"], cwd: dir });
    queue.markWaitingForReset(a.id, "2099-01-01T00:00:00.000Z");
    queue.close();

    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.resumeLoop.state).toBe("absent");
    expect(snapshot.resumeLoop.concern).toBe(true);
    expect(snapshot.resumeLoop.waitingCount).toBe(1);
  });

  it("reports a live resume loop (no concern) with a fresh heartbeat", () => {
    const queue = new RelayQueue(storePath);
    const a = queue.enqueue({ project: "proj-a", tool: "claude-code", command: ["claude", "-p", "hi"], cwd: dir });
    queue.markWaitingForReset(a.id, "2099-01-01T00:00:00.000Z");
    queue.close();
    writeHeartbeat(storePath, 2_000);

    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.resumeLoop.state).toBe("alive");
    expect(snapshot.resumeLoop.concern).toBe(false);
    expect(snapshot.resumeLoop.mode).toBe("daemon");
    expect(snapshot.resumeLoop.pid).toBe(4321);
  });

  it("flags a concern when the heartbeat is stale and jobs are waiting", () => {
    const queue = new RelayQueue(storePath);
    const a = queue.enqueue({ project: "proj-a", tool: "claude-code", command: ["claude", "-p", "hi"], cwd: dir });
    queue.markWaitingForReset(a.id, "2099-01-01T00:00:00.000Z");
    queue.close();
    writeHeartbeat(storePath, 60 * 60_000);

    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.resumeLoop.state).toBe("stale");
    expect(snapshot.resumeLoop.concern).toBe(true);
  });

  it("ignores a garbled heartbeat file (reads as absent)", () => {
    writeFileSync(daemonHeartbeatPath(storePath), "{ not json", "utf8");
    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.resumeLoop.state).toBe("absent");
  });
});
