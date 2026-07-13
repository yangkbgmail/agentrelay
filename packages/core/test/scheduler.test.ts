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

// Fake ChildProcess that lets a test control both output and exit code.
function fakeSpawnFnWithExit(response: { output?: string; exitCode?: number }): SpawnFn {
  return () => {
    const emitter = new EventEmitter() as any;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    setTimeout(() => {
      emitter.stdout.emit("data", Buffer.from(response.output ?? ""));
      emitter.emit("close", response.exitCode ?? 0);
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

  it("re-queues with exponential backoff when the command exits non-zero (no rate limit)", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    const reference = new Date("2026-07-13T00:00:00Z");
    queue.markWaitingForReset(job.id, new Date(reference.getTime() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFnWithExit({ output: "boom, something crashed", exitCode: 1 }),
      retryPolicy: { maxAttempts: 5, baseDelayMs: 60_000, maxDelayMs: 3_600_000, backoffFactor: 2 },
    });

    const [result] = await scheduler.tick(reference);
    expect(result.status).toBe("waiting_for_reset");
    expect(result.retryReason).toBe("error");
    expect(result.lastError).toContain("code 1");
    // attempt 1 -> baseDelay of 60s past the reference time
    expect(result.resetAt).toBe(new Date(reference.getTime() + 60_000).toISOString());
  });

  it("marks a job failed once it exhausts maxAttempts on repeated failures", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    // Pretend we've already burned attempts up to one below the cap.
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());
    (queue as any).update(job.id, { status: "waiting_for_reset", attempts: 2 });

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFnWithExit({ output: "still broken", exitCode: 1 }),
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 1000, backoffFactor: 2 },
    });

    const [result] = await scheduler.tick();
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(3);
    expect(result.lastError).toContain("Gave up after 3 attempts");
  });

  it("gives up on a job that stays rate-limited past maxAttempts instead of looping forever", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());
    (queue as any).update(job.id, { status: "waiting_for_reset", attempts: 1 });

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFnWithExit({ output: "Usage limit reached. Resets in 2h.", exitCode: 0 }),
      retryPolicy: { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 1000, backoffFactor: 2 },
    });

    const [result] = await scheduler.tick();
    expect(result.status).toBe("failed");
    expect(result.lastError).toContain("still rate-limited");
  });

  it("does not mark a non-zero exit as completed", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFnWithExit({ output: "some non-limit error text", exitCode: 2 }),
    });

    const [result] = await scheduler.tick();
    expect(result.status).not.toBe("completed");
  });
});
