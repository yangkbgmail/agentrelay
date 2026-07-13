import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RelayQueue } from "../src/queue.js";
import { RelayScheduler, backoffDelayMs } from "../src/scheduler.js";
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

// Fake that lets each command specify output AND exit code (or a spawn error).
function fakeSpawnWith(
  results: Record<string, { output?: string; exitCode?: number; throwOnSpawn?: boolean }>
): SpawnFn {
  return (command) => {
    const key = command.join(" ");
    const result = results[key] ?? { exitCode: 0 };
    if (result.throwOnSpawn) {
      throw new Error(`spawn ${command[0]} ENOENT`);
    }
    const emitter = new EventEmitter() as any;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    setTimeout(() => {
      if (result.output) emitter.stdout.emit("data", Buffer.from(result.output));
      emitter.emit("close", result.exitCode ?? 0);
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

  it("schedules a backoff retry when the resumed command exits non-zero", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    const ref = new Date("2026-07-13T12:00:00.000Z");
    queue.markWaitingForReset(job.id, new Date(ref.getTime() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnWith({ "claude -p continue": { output: "boom", exitCode: 2 } }),
      retry: { baseDelayMs: 60_000, maxDelayMs: 60_000, maxAttempts: 3 },
    });

    const [result] = await scheduler.tick(ref);
    expect(result.status).toBe("waiting_for_retry");
    expect(result.retryCount).toBe(1);
    expect(result.lastError).toContain("code 2");
    // First retry is scheduled one base-delay into the future.
    expect(result.resetAt).toBe(new Date(ref.getTime() + 60_000).toISOString());
    // The job is due again after the delay elapses.
    expect(queue.listDue(new Date(ref.getTime() + 61_000))).toHaveLength(1);
  });

  it("marks the job failed once the retry budget is exhausted", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnWith({ "claude -p continue": { output: "still broken", exitCode: 1 } }),
      retry: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 2 },
    });

    // Retry 1, retry 2, then exhausted -> failed. Each tick re-runs the now-due job.
    let last = (await scheduler.tick())[0];
    expect(last.status).toBe("waiting_for_retry");
    last = (await scheduler.tick())[0];
    expect(last.status).toBe("waiting_for_retry");
    expect(last.retryCount).toBe(2);
    last = (await scheduler.tick())[0];
    expect(last.status).toBe("failed");
    expect(last.lastError).toContain("code 1");
  });

  it("computes exponential backoff and caps at maxDelayMs", () => {
    const policy = { baseDelayMs: 1000, maxDelayMs: 2500, maxAttempts: 5 };
    expect(backoffDelayMs(0, policy)).toBe(1000);
    expect(backoffDelayMs(1, policy)).toBe(2000);
    expect(backoffDelayMs(2, policy)).toBe(2500); // 4000 capped to 2500
    expect(backoffDelayMs(10, policy)).toBe(2500);
  });

  it("marks the job failed when the command cannot be spawned (retries disabled)", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["nonexistent-binary"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnWith({ "nonexistent-binary": { throwOnSpawn: true } }),
      retry: false,
    });

    const [result] = await scheduler.tick();
    expect(result.status).toBe("failed");
    expect(result.lastError).toContain("ENOENT");
  });

  it("emits a retrying event through the notifier", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const events: string[] = [];
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnWith({ "claude -p continue": { exitCode: 1 } }),
      notify: (p) => {
        events.push(p.event);
      },
    });

    await scheduler.tick();
    expect(events).toContain("resumed");
    expect(events).toContain("retrying");
  });
});
