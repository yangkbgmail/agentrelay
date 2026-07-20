import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonHeartbeat, daemonHeartbeatPath, RelayQueue, serializeDaemonHeartbeat } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJobsSnapshot } from "../lib/jobs";

function writeHeartbeat(storePath: string, overrides: Partial<DaemonHeartbeat> = {}): void {
  const hb: DaemonHeartbeat = {
    pid: 4242,
    mode: "daemon",
    startedAt: new Date().toISOString(),
    lastTickAt: new Date().toISOString(),
    pollIntervalMs: 5_000,
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

  describe("resumeLoop", () => {
    it("reports an absent loop with no waiting jobs as ok (empty store, no heartbeat)", () => {
      const snapshot = readJobsSnapshot(storePath);
      expect(snapshot.resumeLoop).toMatchObject({ state: "absent", severity: "ok", waiting: 0 });
    });

    it("warns when jobs are waiting but no heartbeat file exists", () => {
      const queue = new RelayQueue(storePath);
      const a = queue.enqueue({ project: "p", tool: "claude-code", command: ["claude", "-p", "hi"], cwd: dir });
      queue.markWaitingForReset(a.id, "2099-01-01T00:00:00.000Z");
      queue.close();

      const snapshot = readJobsSnapshot(storePath);
      expect(snapshot.resumeLoop).toMatchObject({ state: "absent", severity: "warning", waiting: 1 });
    });

    it("reports a fresh heartbeat as an alive loop with mode + pid", () => {
      const queue = new RelayQueue(storePath);
      const a = queue.enqueue({ project: "p", tool: "claude-code", command: ["claude", "-p", "hi"], cwd: dir });
      queue.markWaitingForReset(a.id, "2099-01-01T00:00:00.000Z");
      queue.close();
      writeHeartbeat(storePath, { pid: 777, mode: "daemon" });

      const snapshot = readJobsSnapshot(storePath);
      expect(snapshot.resumeLoop).toMatchObject({
        state: "alive",
        severity: "ok",
        mode: "daemon",
        pid: 777,
        waiting: 1,
      });
      expect(snapshot.resumeLoop.ageMs).toBeGreaterThanOrEqual(0);
    });

    it("reports a stale heartbeat (old lastTick) as a stopped loop", () => {
      writeHeartbeat(storePath, {
        pollIntervalMs: 5_000, // stale window = 60s floor
        lastTickAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      });
      const snapshot = readJobsSnapshot(storePath);
      expect(snapshot.resumeLoop).toMatchObject({ state: "stale", severity: "warning" });
    });

    it("treats a garbled heartbeat file as absent instead of throwing", () => {
      writeFileSync(daemonHeartbeatPath(storePath), "{ broken", "utf8");
      const snapshot = readJobsSnapshot(storePath);
      expect(snapshot.resumeLoop.state).toBe("absent");
    });
  });
});
