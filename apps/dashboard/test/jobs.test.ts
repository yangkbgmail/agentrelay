import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonHeartbeat, daemonHeartbeatPath, RelayQueue, serializeDaemonHeartbeat } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJobsSnapshot } from "../lib/jobs";

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

  it("returns empty project/tool rollups for an empty store", () => {
    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.projects.total).toBe(0);
    expect(snapshot.projects.projectCount).toBe(0);
    expect(snapshot.projects.projects).toEqual([]);
    expect(snapshot.tools.total).toBe(0);
    expect(snapshot.tools.toolCount).toBe(0);
    expect(snapshot.tools.tools).toEqual([]);
  });

  it("rolls jobs up by project and tool, mirroring the CLI summaries", () => {
    const queue = new RelayQueue(storePath);
    // proj-a: one waiting (claude-code), one completed (generic)
    const a = queue.enqueue({ project: "proj-a", tool: "claude-code", command: ["claude", "-p", "hi"], cwd: dir });
    queue.markWaitingForReset(a.id, "2099-01-01T00:00:00.000Z");
    const b = queue.enqueue({ project: "proj-a", tool: "generic", command: ["echo", "done"], cwd: dir });
    queue.markCompleted(b.id, "done");
    // proj-b: one completed (claude-code)
    const c = queue.enqueue({ project: "proj-b", tool: "claude-code", command: ["claude", "-p", "bye"], cwd: dir });
    queue.markCompleted(c.id, "ok");
    queue.close();

    const snapshot = readJobsSnapshot(storePath);

    // Projects: proj-a has the pending work so it ranks first (active desc).
    expect(snapshot.projects.total).toBe(3);
    expect(snapshot.projects.projectCount).toBe(2);
    expect(snapshot.projects.projects.map((p) => p.project)).toEqual(["proj-a", "proj-b"]);
    const projA = snapshot.projects.projects[0];
    expect(projA).toMatchObject({ project: "proj-a", total: 2, active: 1, waiting: 1, terminal: 1 });
    expect(projA.nextResetAt).toBe("2099-01-01T00:00:00.000Z");

    // Tools: claude-code appears twice (one waiting), generic once.
    expect(snapshot.tools.toolCount).toBe(2);
    expect(snapshot.tools.tools.map((t) => t.tool)).toEqual(["claude-code", "generic"]);
    const claude = snapshot.tools.tools[0];
    expect(claude).toMatchObject({ tool: "claude-code", total: 2, active: 1, waiting: 1 });
    expect(claude.nextResetAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("survives a corrupt store file instead of crashing the API route", () => {
    writeFileSync(storePath, "{ not json !!", "utf8");
    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.jobs).toEqual([]);
    expect(snapshot.summary.total).toBe(0);
  });

  it("flags a corrupt store and names the moved-aside backup", () => {
    writeFileSync(storePath, "{ not json !!", "utf8");
    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.store.corrupt).toBe(true);
    expect(snapshot.store.backupPath).toContain("jobs.json.corrupt-");
  });

  it("reports a healthy store as not corrupt", () => {
    const queue = new RelayQueue(storePath);
    queue.enqueue({ project: "p", tool: "generic", command: ["echo"], cwd: dir });
    queue.close();

    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.store.corrupt).toBe(false);
    expect(snapshot.store.backupPath).toBeNull();
  });

  it("reports an absent store (first run) as not corrupt", () => {
    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.store.corrupt).toBe(false);
    expect(snapshot.store.backupPath).toBeNull();
  });

  it("reports an absent resume loop when no heartbeat file exists", () => {
    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.heartbeat.state).toBe("absent");
    expect(snapshot.heartbeat.waitingJobs).toBe(0);
    expect(snapshot.heartbeat.concerning).toBe(false);
  });

  it("flags a concerning gap: jobs waiting but no resume loop running", () => {
    const queue = new RelayQueue(storePath);
    const job = queue.enqueue({ project: "p", tool: "generic", command: ["echo"], cwd: dir });
    queue.markWaitingForReset(job.id, "2099-01-01T00:00:00.000Z");
    queue.close();

    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.heartbeat.state).toBe("absent");
    expect(snapshot.heartbeat.waitingJobs).toBe(1);
    expect(snapshot.heartbeat.concerning).toBe(true);
  });

  it("reports an alive resume loop from a fresh daemon heartbeat", () => {
    const queue = new RelayQueue(storePath);
    const job = queue.enqueue({ project: "p", tool: "generic", command: ["echo"], cwd: dir });
    queue.markWaitingForReset(job.id, "2099-01-01T00:00:00.000Z");
    queue.close();

    const heartbeat: DaemonHeartbeat = {
      pid: 4242,
      mode: "daemon",
      startedAt: new Date().toISOString(),
      lastTickAt: new Date().toISOString(),
      pollIntervalMs: 30_000,
    };
    writeFileSync(daemonHeartbeatPath(storePath), serializeDaemonHeartbeat(heartbeat), "utf8");

    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.heartbeat.state).toBe("alive");
    expect(snapshot.heartbeat.mode).toBe("daemon");
    expect(snapshot.heartbeat.pid).toBe(4242);
    expect(snapshot.heartbeat.concerning).toBe(false);
  });

  it("treats a corrupt heartbeat file as an absent resume loop", () => {
    writeFileSync(daemonHeartbeatPath(storePath), "{ broken", "utf8");
    const snapshot = readJobsSnapshot(storePath);
    expect(snapshot.heartbeat.state).toBe("absent");
  });
});
