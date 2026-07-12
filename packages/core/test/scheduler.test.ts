import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RelayQueue } from "../src/queue.js";
import { RelayScheduler, computeBackoffMs, DEFAULT_RETRY_POLICY } from "../src/scheduler.js";
import type { SpawnFn } from "../src/scheduler.js";

// Minimal fake ChildProcess: emits given stdout data then closes with code 0.
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

// Fake that exits with a non-zero code, optionally after writing output.
function exitingSpawnFn(code: number, output = ""): SpawnFn {
  return () => {
    const emitter = new EventEmitter() as any;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    setTimeout(() => {
      if (output) emitter.stderr.emit("data", Buffer.from(output));
      emitter.emit("close", code);
    }, 0);
    return emitter;
  };
}

// Fake that fails to spawn / emits an "error" event.
function erroringSpawnFn(message: string): SpawnFn {
  return () => {
    const emitter = new EventEmitter() as any;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    setTimeout(() => emitter.emit("error", new Error(message)), 0);
    return emitter;
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

  it("re-queues with exponential backoff when the command fails (non-zero exit)", async () => {
    const job = queue.enqueue({ project: "demo", tool: "generic", command: ["boom"], cwd: dir });
    queue.markWaitingForReset(job.id, new Date(0).toISOString());

    const now = new Date("2026-07-12T10:00:00Z");
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: exitingSpawnFn(1, "segfault"),
      retryPolicy: { maxAttempts: 3, baseBackoffMs: 60_000, maxBackoffMs: 60 * 60_000 },
    });

    const [result] = await scheduler.tick(now);
    expect(result.status).toBe("waiting_for_reset");
    expect(result.retryCount).toBe(1);
    expect(result.lastError).toContain("exited with code 1");
    // First failure backoff = base * 2^0 = 60s from the reference time.
    expect(result.resetAt).toBe(new Date(now.getTime() + 60_000).toISOString());
  });

  it("gives up and marks the job failed once max attempts is reached", async () => {
    const job = queue.enqueue({ project: "demo", tool: "generic", command: ["boom"], cwd: dir });
    // Simulate having already failed twice.
    queue.markRetry(job.id, new Date(0).toISOString(), "prior failure");
    queue.markRetry(job.id, new Date(0).toISOString(), "prior failure");
    expect(queue.getById(job.id)!.retryCount).toBe(2);

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: exitingSpawnFn(1),
      retryPolicy: { maxAttempts: 3, baseBackoffMs: 1000, maxBackoffMs: 10_000 },
    });

    const [result] = await scheduler.tick(new Date());
    expect(result.status).toBe("failed");
    expect(result.lastError).toContain("exited with code 1");
  });

  it("treats a spawn/error event as a retryable failure", async () => {
    const job = queue.enqueue({ project: "demo", tool: "generic", command: ["nope"], cwd: dir });
    queue.markWaitingForReset(job.id, new Date(0).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: erroringSpawnFn("ENOENT: command not found"),
      retryPolicy: { maxAttempts: 3, baseBackoffMs: 5_000, maxBackoffMs: 60_000 },
    });

    const [result] = await scheduler.tick(new Date());
    expect(result.status).toBe("waiting_for_reset");
    expect(result.retryCount).toBe(1);
    expect(result.lastError).toContain("ENOENT");
  });

  it("resets the failure counter after a real rate-limit re-queue", async () => {
    const job = queue.enqueue({ project: "demo", tool: "generic", command: ["x"], cwd: dir });
    queue.markRetry(job.id, new Date(0).toISOString(), "earlier flake");
    expect(queue.getById(job.id)!.retryCount).toBe(1);

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({ x: "Usage limit reached. Resets in 2h." }),
    });

    const [result] = await scheduler.tick();
    expect(result.status).toBe("waiting_for_reset");
    expect(result.retryCount).toBe(0);
    expect(result.lastError).toBeNull();
  });

  it("computeBackoffMs grows exponentially and respects the cap", () => {
    const policy = { maxAttempts: 10, baseBackoffMs: 1000, maxBackoffMs: 5000 };
    expect(computeBackoffMs(policy, 1)).toBe(1000);
    expect(computeBackoffMs(policy, 2)).toBe(2000);
    expect(computeBackoffMs(policy, 3)).toBe(4000);
    expect(computeBackoffMs(policy, 4)).toBe(5000); // capped
    expect(computeBackoffMs(policy, 99)).toBe(5000);
    // Default policy exposed and sane.
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeGreaterThan(0);
  });
});
