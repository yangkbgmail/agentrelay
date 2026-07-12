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

// Fake ChildProcess that exits with a specific (non-zero) code, optionally
// emitting stderr output first.
function exitCodeSpawnFn(code: number, stderr = ""): SpawnFn {
  return () => {
    const emitter = new EventEmitter() as any;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    setTimeout(() => {
      if (stderr) emitter.stderr.emit("data", Buffer.from(stderr));
      emitter.emit("close", code);
    }, 0);
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

  it("re-queues with backoff (not failed) when a resumed command exits non-zero, under the retry cap", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    const now = new Date();
    queue.markWaitingForReset(job.id, new Date(now.getTime() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: exitCodeSpawnFn(1, "boom: transient crash"),
      retryPolicy: { maxRetries: 3, baseDelayMs: 1000, factor: 2 },
    });

    const [result] = await scheduler.tick(now);
    expect(result.status).toBe("waiting_for_reset");
    expect(result.retries).toBe(1);
    expect(result.lastError).toContain("exited with code 1");
    // First retry uses baseDelayMs (1000ms) -> retryAt ~ now + 1s.
    expect(new Date(result.resetAt!).getTime()).toBe(now.getTime() + 1000);
  });

  it("gives up and marks failed once the retry cap is exhausted", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    const now = new Date();
    queue.markWaitingForReset(job.id, new Date(now.getTime() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: exitCodeSpawnFn(1),
      retryPolicy: { maxRetries: 2, baseDelayMs: 10, factor: 2 },
    });

    // Attempt 1 -> retry (retries=1), attempt 2 -> retry (retries=2), attempt 3 -> failed.
    let last = (await scheduler.tick(now))[0];
    expect(last.status).toBe("waiting_for_reset");
    expect(last.retries).toBe(1);

    // Make it due again and tick.
    queue.markWaitingForReset(last.id, new Date(now.getTime() - 1000).toISOString());
    last = (await scheduler.tick(now))[0];
    expect(last.status).toBe("waiting_for_reset");
    expect(last.retries).toBe(2);

    queue.markWaitingForReset(last.id, new Date(now.getTime() - 1000).toISOString());
    last = (await scheduler.tick(now))[0];
    expect(last.status).toBe("failed");
    expect(last.retries).toBe(2);
    expect(last.lastError).toContain("exited with code 1");
  });

  it("caps the backoff delay at maxDelayMs", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: exitCodeSpawnFn(1),
      retryPolicy: { baseDelayMs: 1000, factor: 10, maxDelayMs: 5000 },
    });
    // 1000 * 10^0 = 1000, 10^1 = 10000 -> capped to 5000, 10^2 -> capped.
    expect(scheduler.backoffDelayMs(0)).toBe(1000);
    expect(scheduler.backoffDelayMs(1)).toBe(5000);
    expect(scheduler.backoffDelayMs(2)).toBe(5000);
    void job;
  });

  it("does not consume a retry when the command hits a rate limit again", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({ "claude -p continue": "Usage limit reached again. Resets in 2h." }),
    });

    const [result] = await scheduler.tick();
    expect(result.status).toBe("waiting_for_reset");
    expect(result.retries).toBe(0); // rate-limit re-queue is not a failure retry
  });
});
