import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RelayQueue } from "../src/queue.js";
import { RelayScheduler, backoffDelayMs, DEFAULT_RETRY_POLICY } from "../src/scheduler.js";
import type { SpawnFn } from "../src/scheduler.js";

// Fake spawn that emits configurable output and exit code per command.
function fakeSpawnFn(spec: { output?: string; exitCode?: number; throwOnSpawn?: boolean }): SpawnFn {
  return () => {
    if (spec.throwOnSpawn) {
      throw new Error("spawn ENOENT");
    }
    const emitter = new EventEmitter() as any;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    setTimeout(() => {
      emitter.stdout.emit("data", Buffer.from(spec.output ?? ""));
      emitter.emit("close", spec.exitCode ?? 0);
    }, 0);
    return emitter;
  };
}

describe("backoffDelayMs", () => {
  it("grows exponentially and clamps at maxBackoffMs", () => {
    const policy = { maxAttempts: 10, baseBackoffMs: 1000, maxBackoffMs: 8000, backoffFactor: 2 };
    expect(backoffDelayMs(policy, 1)).toBe(1000);
    expect(backoffDelayMs(policy, 2)).toBe(2000);
    expect(backoffDelayMs(policy, 3)).toBe(4000);
    expect(backoffDelayMs(policy, 4)).toBe(8000);
    // clamped
    expect(backoffDelayMs(policy, 5)).toBe(8000);
    expect(backoffDelayMs(policy, 99)).toBe(8000);
  });
});

describe("RelayScheduler retry policy", () => {
  let dir: string;
  let queue: RelayQueue;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-retry-test-"));
    queue = new RelayQueue(join(dir, "test.db"));
  });

  afterEach(() => {
    queue.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function enqueueDue() {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());
    return job;
  }

  it("re-queues a failing (non-zero exit) command with exponential backoff", async () => {
    const job = enqueueDue();
    const now = new Date("2026-07-13T09:00:00.000Z");
    queue.markWaitingForReset(job.id, new Date(now.getTime() - 1000).toISOString());
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({ output: "boom, something broke", exitCode: 1 }),
      retry: { maxAttempts: 5, baseBackoffMs: 60_000, maxBackoffMs: 3_600_000, backoffFactor: 2 },
    });

    const [result] = await scheduler.tick(now);
    expect(result.status).toBe("waiting_for_reset");
    // attempt 1 -> base backoff of 60s from `now`
    expect(result.resetAt).toBe(new Date(now.getTime() + 60_000).toISOString());
    expect(result.lastError).toContain("exited with code 1");
    expect(result.attempts).toBe(1);
  });

  it("gives up and marks failed once maxAttempts is reached", async () => {
    const job = enqueueDue();
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({ output: "still broken", exitCode: 1 }),
      retry: { maxAttempts: 3, baseBackoffMs: 1, maxBackoffMs: 1, backoffFactor: 2 },
    });

    // Attempts 1 and 2 re-queue; attempt 3 exhausts the budget -> failed.
    let last;
    for (let i = 0; i < 3; i++) {
      // each tick needs the job to be "due" again
      queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());
      [last] = await scheduler.tick();
    }
    expect(last!.status).toBe("failed");
    expect(last!.attempts).toBe(3);
    expect(last!.lastError).toContain("gave up after 3 attempts");
  });

  it("gives up on a rate-limit loop once maxAttempts is reached", async () => {
    const job = enqueueDue();
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({ output: "Usage limit reached again. Resets in 2h." }),
      retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 2 },
    });

    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());
    let [last] = await scheduler.tick();
    expect(last.status).toBe("waiting_for_reset"); // attempt 1: re-queued

    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());
    [last] = await scheduler.tick();
    expect(last.status).toBe("failed"); // attempt 2: budget exhausted
    expect(last.lastError).toContain("still rate-limited");
  });

  it("marks failed when the command cannot be spawned at all", async () => {
    enqueueDue();
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({ throwOnSpawn: true }),
      retry: { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 1, backoffFactor: 2 },
    });

    const [result] = await scheduler.tick();
    expect(result.status).toBe("failed");
    expect(result.lastError).toContain("spawn ENOENT");
  });

  it("still completes a genuinely successful job (exit 0, no limit)", async () => {
    enqueueDue();
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({ output: "All done!", exitCode: 0 }),
    });
    const [result] = await scheduler.tick();
    expect(result.status).toBe("completed");
  });
});
