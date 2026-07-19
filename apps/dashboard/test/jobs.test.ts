import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonHeartbeat, daemonHeartbeatPath, RelayQueue, serializeDaemonHeartbeat } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJobsSnapshot } from "../lib/jobs";

function writeHeartbeat(storePath: string, overrides: Partial<DaemonHeartbeat> = {}): void {
  const hb: DaemonHeartbeat = {
    pid: 4321,
    mode: "daemon",
    startedAt: new Date().toISOString(),
    lastTickAt: new Date().toISOString(),
    pollIntervalMs: 30_000,
    ...overrides,
  };
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

  it("reports 'no resume loop running' when there is no heartbeat and nothing waits", () => {
    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.resumeLoop.state).toBe("absent");
    expect(snapshot.resumeLoop.needsAttention).toBe(false);
  });

  it("flags needsAttention when jobs wait but no heartbeat exists", () => {
    const queue = new RelayQueue(storePath);
    const a = queue.enqueue({ project: "p", tool: "generic", command: ["echo", "hi"], cwd: dir });
    queue.markWaitingForReset(a.id, "2099-01-01T00:00:00.000Z");
    queue.close();

    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.resumeLoop.activeCount).toBe(1);
    expect(snapshot.resumeLoop.state).toBe("absent");
    expect(snapshot.resumeLoop.needsAttention).toBe(true);
  });

  it("reports a live resume loop from a fresh heartbeat", () => {
    const queue = new RelayQueue(storePath);
    const a = queue.enqueue({ project: "p", tool: "generic", command: ["echo", "hi"], cwd: dir });
    queue.markWaitingForReset(a.id, "2099-01-01T00:00:00.000Z");
    queue.close();
    writeHeartbeat(storePath);

    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.resumeLoop.state).toBe("running");
    expect(snapshot.resumeLoop.live).toBe(true);
    expect(snapshot.resumeLoop.needsAttention).toBe(false);
  });

  it("flags a stale heartbeat with waiting jobs as needing attention", () => {
    const queue = new RelayQueue(storePath);
    const a = queue.enqueue({ project: "p", tool: "generic", command: ["echo", "hi"], cwd: dir });
    queue.markWaitingForReset(a.id, "2099-01-01T00:00:00.000Z");
    queue.close();
    // A tick heartbeat whose last tick is far past the 15m window.
    writeHeartbeat(storePath, {
      mode: "tick",
      pollIntervalMs: 0,
      lastTickAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.resumeLoop.state).toBe("stale");
    expect(snapshot.resumeLoop.needsAttention).toBe(true);
  });

  it("degrades gracefully when the heartbeat file is garbled", () => {
    writeFileSync(daemonHeartbeatPath(storePath), "{ broken", "utf8");
    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.resumeLoop.state).toBe("absent");
  });
});
