import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RelayQueue } from "../src/queue.js";
import { RelayScheduler } from "../src/scheduler.js";
import type { SpawnFn } from "../src/scheduler.js";

// Minimal fake ChildProcess: emits given stdout data then closes.
function fakeSpawnFn(outputs: Record<string, string>): SpawnFn {
  return (command) => {
    const key = command.join(" ");
    const emitter = new EventEmitter() as any;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    setTimeout(() => {
      emitter.stdout.emit("data", Buffer.from(outputs[key] ?? ""));
      emitter.emit("close", 0);
    }, 0);
    return emitter;
  };
}

// Fake ChildProcess that exits with a given non-zero code (a failed command).
function failingSpawnFn(exitCode: number, output = ""): SpawnFn {
  return () => {
    const emitter = new EventEmitter() as any;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    setTimeout(() => {
      if (output) emitter.stderr.emit("data", Buffer.from(output));
      emitter.emit("close", exitCode);
    }, 0);
    return emitter;
  };
}

// Fake spawn that throws synchronously (e.g. command not found / ENOENT).
function throwingSpawnFn(): SpawnFn {
  return () => {
    throw new Error("spawn claude ENOENT");
  };
}

describe("RelayScheduler", () => {
  let dir: string;
  let queue: RelayQueue;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-sched-test-"));
    queue = new RelayQueue(join(dir, "test.db"));
  });

  afterEach(() => {
    queue.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("marks a job completed when the resumed command succeeds without hitting a limit again", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({ "claude -p continue": "All done, task finished successfully." }),
    });

    const results = await scheduler.tick();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("completed");
  });

  it("re-queues a job that hits the rate limit again during resume", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({
        "claude -p continue": "Usage limit reached again. Resets in 2h.",
      }),
    });

    const results = await scheduler.tick();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("waiting_for_reset");
    expect(results[0].resetAt).not.toBeNull();
  });

  it("re-queues a failed command for a backoff retry instead of marking it completed", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    const dueAt = new Date(Date.now() - 1000);
    queue.markWaitingForReset(job.id, dueAt.toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: failingSpawnFn(1, "boom: something went wrong"),
      retryPolicy: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 10_000, factor: 2 },
    });

    const results = await scheduler.tick(dueAt);
    expect(results).toHaveLength(1);
    const updated = results[0];
    expect(updated.status).toBe("waiting_for_reset");
    expect(updated.retryCount).toBe(1);
    expect(updated.lastError).toContain("exited with code 1");
    // Backoff of baseDelayMs (1000) from the reference time.
    expect(new Date(updated.resetAt!).getTime()).toBe(dueAt.getTime() + 1000);
  });

  it("gives up (marks failed) once maxRetries is exhausted", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    // Simulate a job that has already used all its retries.
    queue.markRetry(job.id, new Date(Date.now() - 1000).toISOString(), "prev failure");
    const dueAt = new Date();
    queue.markWaitingForReset(job.id, new Date(dueAt.getTime() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: failingSpawnFn(2),
      retryPolicy: { maxRetries: 1, baseDelayMs: 1000, maxDelayMs: 10_000, factor: 2 },
    });

    const results = await scheduler.tick(dueAt);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("failed");
    expect(results[0].lastError).toContain("exited with code 2");
  });

  it("treats a spawn error (e.g. command not found) as a failure to retry", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    const dueAt = new Date();
    queue.markWaitingForReset(job.id, new Date(dueAt.getTime() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: throwingSpawnFn(),
      retryPolicy: { maxRetries: 2, baseDelayMs: 1000, maxDelayMs: 10_000, factor: 2 },
    });

    const results = await scheduler.tick(dueAt);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("waiting_for_reset");
    expect(results[0].retryCount).toBe(1);
    expect(results[0].lastError).toContain("ENOENT");
  });

  it("does not touch jobs that are not yet due", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() + 60_000).toISOString());

    const scheduler = new RelayScheduler({ queue, spawnFn: fakeSpawnFn({}) });
    const results = await scheduler.tick();
    expect(results).toHaveLength(0);
  });
});
