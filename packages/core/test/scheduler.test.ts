import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RelayQueue } from "../src/queue.js";
import type { SpawnFn } from "../src/scheduler.js";
import { RelayScheduler } from "../src/scheduler.js";

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

// Fake ChildProcess that closes with a given exit code (default 0) and,
// optionally, emits an `error` event instead of closing cleanly.
function fakeSpawnWith(opts: { output?: string; exitCode?: number; error?: Error }): SpawnFn {
  return () => {
    const emitter = new EventEmitter() as any;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    setTimeout(() => {
      if (opts.output) emitter.stdout.emit("data", Buffer.from(opts.output));
      if (opts.error) {
        emitter.emit("error", opts.error);
      } else {
        emitter.emit("close", opts.exitCode ?? 0);
      }
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

  function dueJob() {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());
    return job;
  }

  it("backs off and re-queues a job whose command exits non-zero (transient failure)", async () => {
    dueJob(); // resetAt = Date.now() - 1000
    const now = new Date(Date.now() + 1000); // reference time after the job became due
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnWith({ output: "boom", exitCode: 1 }),
      retryPolicy: { maxAttempts: 5, baseDelayMs: 60_000, factor: 2, maxDelayMs: 3_600_000 },
    });

    const [result] = await scheduler.tick(now);
    expect(result.status).toBe("waiting_for_reset");
    // attempt 1 -> base delay of 60s from the reference time
    expect(result.resetAt).toBe(new Date(now.getTime() + 60_000).toISOString());
    expect(result.lastError).toContain("exited with code 1");
  });

  it("retries a spawn/child error rather than dropping the job", async () => {
    dueJob();
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnWith({ error: new Error("ENOENT") }),
    });

    const [result] = await scheduler.tick();
    expect(result.status).toBe("waiting_for_reset");
    expect(result.lastError).toContain("ENOENT");
  });

  it("marks a job failed once it exhausts maxAttempts on repeated failures", async () => {
    const job = dueJob();
    // Simulate a job that has already burned through its budget.
    queue.markResuming(job.id); // attempts -> 1
    queue.markResuming(job.id); // attempts -> 2
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnWith({ output: "still broken", exitCode: 2 }),
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1000, factor: 2, maxDelayMs: 10_000 },
    });

    // This resume is attempt 3 (== maxAttempts) -> should fail, not retry.
    const [result] = await scheduler.tick();
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(3);
    expect(result.lastError).toContain("Failed after 3 attempt(s)");
  });

  it("gives up on a job that stays rate-limited past maxAttempts", async () => {
    const job = dueJob();
    queue.markResuming(job.id); // attempts -> 1
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnWith({ output: "Usage limit reached. Resets in 2h." }),
      retryPolicy: { maxAttempts: 2, baseDelayMs: 1000, factor: 2, maxDelayMs: 10_000 },
    });

    // attempt 2 == maxAttempts, still rate-limited -> failed instead of looping.
    const [result] = await scheduler.tick();
    expect(result.status).toBe("failed");
    expect(result.lastError).toContain("Still rate-limited");
  });

  it("keeps re-queuing a rate-limited job forever when maxAttempts is 0", async () => {
    const job = dueJob();
    queue.markResuming(job.id);
    queue.markResuming(job.id);
    queue.markResuming(job.id); // attempts -> 3, well past a normal cap
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnWith({ output: "Usage limit reached. Resets in 2h." }),
      retryPolicy: { maxAttempts: 0, baseDelayMs: 1000, factor: 2, maxDelayMs: 10_000 },
    });

    const [result] = await scheduler.tick();
    expect(result.status).toBe("waiting_for_reset");
  });
});
