import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { corruptBackupPath, RelayQueue } from "../src/queue.js";
import type { RelayJob } from "../src/types.js";

describe("RelayQueue", () => {
  let dir: string;
  let queue: RelayQueue;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-test-"));
    queue = new RelayQueue(join(dir, "test.db"));
  });

  afterEach(() => {
    queue.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("enqueues a job with status 'queued'", () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: "/tmp/demo",
    });
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(queue.getById(job.id)?.id).toBe(job.id);
  });

  it("moves a job to waiting_for_reset and lists it once due", () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: "/tmp/demo",
    });
    const resetAt = new Date(Date.now() + 1000).toISOString();
    queue.markWaitingForReset(job.id, resetAt);

    expect(queue.listDue(new Date(Date.now()))).toHaveLength(0);
    expect(queue.listDue(new Date(Date.now() + 2000))).toHaveLength(1);
  });

  it("initializes lastRateLimit to null on enqueue", () => {
    const job = queue.enqueue({ project: "demo", tool: "claude-code", command: ["claude"], cwd: "/tmp" });
    expect(job.lastRateLimit).toBeNull();
  });

  it("persists rate-limit detection provenance when parking a job", () => {
    const job = queue.enqueue({ project: "demo", tool: "claude-code", command: ["claude"], cwd: "/tmp" });
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    const detection = { pattern: "clock-time-meridiem", rawMatch: "reset at 5pm", resetAt, detectedAt: resetAt };
    queue.markWaitingForReset(job.id, resetAt, detection);

    const reloaded = queue.getById(job.id);
    expect(reloaded?.lastRateLimit).toEqual(detection);
    expect(reloaded?.resetAt).toBe(resetAt);
  });

  it("leaves lastRateLimit untouched when parking without a detection", () => {
    const job = queue.enqueue({ project: "demo", tool: "claude-code", command: ["claude"], cwd: "/tmp" });
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    queue.markWaitingForReset(job.id, resetAt);
    expect(queue.getById(job.id)?.lastRateLimit).toBeNull();
  });

  it("tracks attempts across resumes", () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: "/tmp/demo",
    });
    queue.markResuming(job.id);
    queue.markResuming(job.id);
    expect(queue.getById(job.id)?.attempts).toBe(2);
  });

  it("marks completion and failure with details", () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: "/tmp/demo",
    });
    queue.markCompleted(job.id, "all done");
    expect(queue.getById(job.id)?.status).toBe("completed");
    expect(queue.getById(job.id)?.lastOutputTail).toBe("all done");

    const job2 = queue.enqueue({
      project: "demo2",
      tool: "codex-cli",
      command: ["codex", "run"],
      cwd: "/tmp/demo2",
    });
    queue.markFailed(job2.id, "boom");
    expect(queue.getById(job2.id)?.status).toBe("failed");
    expect(queue.getById(job2.id)?.lastError).toBe("boom");
  });

  it("lists all jobs newest first", () => {
    queue.enqueue({ project: "a", tool: "claude-code", command: ["x"], cwd: "/tmp" });
    queue.enqueue({ project: "b", tool: "claude-code", command: ["y"], cwd: "/tmp" });
    const all = queue.listAll();
    expect(all).toHaveLength(2);
  });

  it("cancels a pending job into the terminal cancelled state", () => {
    const job = queue.enqueue({ project: "demo", tool: "claude-code", command: ["claude"], cwd: "/tmp" });
    queue.markWaitingForReset(job.id, new Date(Date.now() + 60_000).toISOString());
    queue.markCancelled(job.id);
    expect(queue.getById(job.id)?.status).toBe("cancelled");
    // A cancelled job is no longer picked up as due, even past its reset time.
    expect(queue.listDue(new Date(Date.now() + 120_000))).toHaveLength(0);
  });

  describe("corrupt store recovery", () => {
    it("preserves a corrupt store file instead of clobbering it, and starts fresh", () => {
      const storePath = join(dir, "corrupt.db");
      writeFileSync(storePath, "{ this is not valid json ]", "utf8");

      const events: Array<{ path: string; backupPath: string | null }> = [];
      const recovered = new RelayQueue(storePath, {
        onCorrupt: ({ path, backupPath }) => events.push({ path, backupPath }),
      });

      // Started with an empty queue rather than crashing.
      expect(recovered.listAll()).toHaveLength(0);

      // The callback fired with a real backup path...
      expect(events).toHaveLength(1);
      expect(events[0].path).toBe(storePath);
      expect(events[0].backupPath).not.toBeNull();

      // ...and that backup file still holds the original unreadable bytes.
      const backupPath = events[0].backupPath as string;
      expect(existsSync(backupPath)).toBe(true);
      expect(readFileSync(backupPath, "utf8")).toBe("{ this is not valid json ]");
      expect(basename(backupPath).startsWith("corrupt.db.corrupt-")).toBe(true);

      // A subsequent write rewrites the (now-absent) main path cleanly without
      // destroying the preserved copy.
      const job = recovered.enqueue({ project: "p", tool: "claude-code", command: ["x"], cwd: "/tmp" });
      recovered.close();
      expect(JSON.parse(readFileSync(storePath, "utf8"))).toHaveLength(1);
      expect(recovered.getById(job.id)?.id).toBe(job.id);
      // Exactly one backup was made (no duplicate backups on later loads).
      const backups = readdirSync(dir).filter((f) => f.startsWith("corrupt.db.corrupt-"));
      expect(backups).toHaveLength(1);
    });

    it("treats a non-array JSON root as corrupt", () => {
      const storePath = join(dir, "object.db");
      writeFileSync(storePath, '{"not":"an array"}', "utf8");
      let backupPath: string | null | undefined;
      const q = new RelayQueue(storePath, { onCorrupt: (info) => (backupPath = info.backupPath) });
      expect(q.listAll()).toHaveLength(0);
      expect(backupPath).toBeTruthy();
    });

    it("does NOT treat an empty or whitespace-only file as corrupt", () => {
      const storePath = join(dir, "empty.db");
      writeFileSync(storePath, "   \n", "utf8");
      let called = false;
      const q = new RelayQueue(storePath, { onCorrupt: () => (called = true) });
      expect(q.listAll()).toHaveLength(0);
      expect(called).toBe(false);
      // No backup file was created.
      expect(readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(false);
    });

    it("corruptBackupPath produces a filesystem-safe, deterministic suffix", () => {
      const at = new Date("2026-07-18T12:34:56.789Z");
      expect(corruptBackupPath("/a/b/jobs.json", at)).toBe("/a/b/jobs.json.corrupt-2026-07-18T12-34-56-789Z");
    });
  });

  it("requeues a job to run now with a fresh attempt count", () => {
    const job = queue.enqueue({ project: "demo", tool: "claude-code", command: ["claude"], cwd: "/tmp" });
    queue.markResuming(job.id);
    queue.markFailed(job.id, "exhausted attempts");
    expect(queue.getById(job.id)?.attempts).toBe(1);

    queue.requeueNow(job.id);
    const requeued = queue.getById(job.id);
    expect(requeued?.status).toBe("waiting_for_reset");
    expect(requeued?.attempts).toBe(0);
    expect(requeued?.lastError).toBeNull();
    // resetAt is now (or earlier), so the job is immediately due.
    expect(queue.listDue(new Date(Date.now() + 1000))).toHaveLength(1);
  });

  describe("importJobs", () => {
    const historyJob = (id: string, project = "imported"): RelayJob => ({
      id,
      project,
      tool: "claude-code",
      command: ["claude", "-p", "go"],
      cwd: "/tmp",
      status: "completed",
      resetAt: null,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T01:00:00.000Z",
      attempts: 1,
      lastError: null,
      lastOutputTail: null,
    });

    it("adds new history jobs and persists them across reloads", () => {
      const result = queue.importJobs([historyJob("a"), historyJob("b")]);
      expect(result).toEqual({ added: 2, updated: 0, skippedExisting: 0, skippedActive: 0 });

      const reopened = new RelayQueue(join(dir, "test.db"));
      expect(reopened.getById("a")?.project).toBe("imported");
      expect(reopened.getById("b")?.project).toBe("imported");
    });

    it("skips existing ids by default and overwrites when asked", () => {
      queue.importJobs([historyJob("dup", "original")]);

      const skip = queue.importJobs([historyJob("dup", "changed")]);
      expect(skip).toMatchObject({ added: 0, updated: 0, skippedExisting: 1 });
      expect(queue.getById("dup")?.project).toBe("original");

      const over = queue.importJobs([historyJob("dup", "changed")], { overwrite: true });
      expect(over).toMatchObject({ added: 0, updated: 1 });
      expect(queue.getById("dup")?.project).toBe("changed");
    });

    it("excludes active jobs unless includeActive is set", () => {
      const active: RelayJob = {
        ...historyJob("live"),
        status: "waiting_for_reset",
        resetAt: "2026-07-11T00:00:00.000Z",
      };
      const skipped = queue.importJobs([active]);
      expect(skipped).toMatchObject({ added: 0, skippedActive: 1 });
      expect(queue.getById("live")).toBeUndefined();

      const included = queue.importJobs([active], { includeActive: true });
      expect(included).toMatchObject({ added: 1, skippedActive: 0 });
      expect(queue.getById("live")?.status).toBe("waiting_for_reset");
    });

    it("does not rewrite the store when the plan is a pure skip", () => {
      queue.importJobs([historyJob("keep")]);
      const before = readFileSync(join(dir, "test.db"), "utf8");
      const result = queue.importJobs([historyJob("keep", "different")]);
      expect(result).toMatchObject({ added: 0, updated: 0, skippedExisting: 1 });
      expect(readFileSync(join(dir, "test.db"), "utf8")).toBe(before);
    });
  });
});
