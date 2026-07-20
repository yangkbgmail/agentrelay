import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_HEARTBEAT_FILENAME,
  type DaemonHeartbeat,
  RelayQueue,
  serializeDaemonHeartbeat,
} from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJobsSnapshot } from "../lib/jobs";

function writeHeartbeat(dir: string, overrides: Partial<DaemonHeartbeat> = {}): void {
  const now = new Date();
  const hb: DaemonHeartbeat = {
    pid: 999,
    mode: "daemon",
    startedAt: now.toISOString(),
    lastTickAt: now.toISOString(),
    pollIntervalMs: 30_000,
    ...overrides,
  };
  writeFileSync(join(dir, DAEMON_HEARTBEAT_FILENAME), serializeDaemonHeartbeat(hb), "utf8");
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

  it("reports the resume loop as absent+ok when no heartbeat and nothing waiting", () => {
    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.resumeLoop.state).toBe("absent");
    expect(snapshot.resumeLoop.level).toBe("ok");
    expect(snapshot.resumeLoop.waitingCount).toBe(0);
  });

  it("warns when jobs are waiting but no heartbeat exists", () => {
    const queue = new RelayQueue(storePath);
    const a = queue.enqueue({ project: "p", tool: "claude-code", command: ["claude"], cwd: dir });
    queue.markWaitingForReset(a.id, "2099-01-01T00:00:00.000Z");
    queue.close();

    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.resumeLoop.state).toBe("absent");
    expect(snapshot.resumeLoop.level).toBe("warning");
    expect(snapshot.resumeLoop.waitingCount).toBe(1);
  });

  it("reports the resume loop as alive when a fresh heartbeat sits next to the store", () => {
    const queue = new RelayQueue(storePath);
    const a = queue.enqueue({ project: "p", tool: "claude-code", command: ["claude"], cwd: dir });
    queue.markWaitingForReset(a.id, "2099-01-01T00:00:00.000Z");
    queue.close();
    writeHeartbeat(dir);

    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.resumeLoop.state).toBe("alive");
    expect(snapshot.resumeLoop.level).toBe("ok");
  });

  it("warns when a heartbeat exists but is stale and jobs are waiting", () => {
    const queue = new RelayQueue(storePath);
    const a = queue.enqueue({ project: "p", tool: "claude-code", command: ["claude"], cwd: dir });
    queue.markWaitingForReset(a.id, "2099-01-01T00:00:00.000Z");
    queue.close();
    // last tick 10 minutes ago, far past a 30s daemon's stale window
    writeHeartbeat(dir, { lastTickAt: new Date(Date.now() - 10 * 60_000).toISOString() });

    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.resumeLoop.state).toBe("stale");
    expect(snapshot.resumeLoop.level).toBe("warning");
  });

  it("ignores a corrupt heartbeat file (reads as absent)", () => {
    writeFileSync(join(dir, DAEMON_HEARTBEAT_FILENAME), "{ broken", "utf8");
    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.resumeLoop.state).toBe("absent");
  });
});
