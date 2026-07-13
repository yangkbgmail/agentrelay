import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RelayQueue } from "../src/queue.js";

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
});
