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

// Fake ChildProcess that exits with a chosen (possibly non-zero) code.
function fakeSpawnExit(code: number, output = ""): SpawnFn {
  return () => {
    const emitter = new EventEmitter() as any;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    setTimeout(() => {
      if (output) emitter.stdout.emit("data", Buffer.from(output));
      emitter.emit("close", code);
    }, 0);
    return emitter;
  };
}

// Fake ChildProcess that emits an "error" (e.g. spawn ENOENT).
function fakeSpawnError(message: string): SpawnFn {
  return () => {
    const emitter = new EventEmitter() as any;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    setTimeout(() => emitter.emit("error", new Error(message)), 0);
    return emitter;
  };
}

function dueJob(queue: RelayQueue, dir: string): string {
  const job = queue.enqueue({
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: dir,
  });
  queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());
  return job.id;
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

  it("retries a transient failure with exponential backoff instead of failing outright", async () => {
    const id = dueJob(queue, dir);
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnExit(1, "boom: something crashed, not a rate limit"),
    });

    const before = Date.now();
    const results = await scheduler.tick();
    expect(results).toHaveLength(1);
    const job = results[0];
    expect(job.status).toBe("waiting_for_reset");
    expect(job.waitReason).toBe("backoff");
    // First backoff is baseDelayMs (30s) into the future.
    expect(new Date(job.resetAt!).getTime()).toBeGreaterThan(before);
    expect(queue.getById(id)?.attempts).toBe(1);
  });

  it("retries when the spawn itself errors (e.g. command not found)", async () => {
    dueJob(queue, dir);
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnError("spawn claude ENOENT"),
    });

    const results = await scheduler.tick();
    expect(results[0].status).toBe("waiting_for_reset");
    expect(results[0].waitReason).toBe("backoff");
    expect(results[0].lastError).toBeNull();
  });

  it("gives up and marks failed once maxAttempts is exhausted on repeated failures", async () => {
    dueJob(queue, dir);
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnExit(2, "still broken"),
      retryPolicy: { maxAttempts: 1 },
    });

    const results = await scheduler.tick();
    expect(results[0].status).toBe("failed");
    expect(results[0].lastError).toContain("exited with code 2");
  });

  it("stops relaying and fails a job that keeps hitting the rate limit past maxAttempts", async () => {
    dueJob(queue, dir);
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({ "claude -p continue": "Usage limit reached again. Resets in 2h." }),
      retryPolicy: { maxAttempts: 1 },
    });

    const results = await scheduler.tick();
    expect(results[0].status).toBe("failed");
    expect(results[0].lastError).toContain("still rate-limited");
  });

  it("marks a non-zero exit with no rate limit as a failure, not a completion", async () => {
    dueJob(queue, dir);
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnExit(1, "unrelated error output"),
    });

    const results = await scheduler.tick();
    expect(results[0].status).not.toBe("completed");
    expect(results[0].status).toBe("waiting_for_reset");
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
