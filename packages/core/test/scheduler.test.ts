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

// Fake ChildProcess that emits an "error" event (spawn/child failure).
function erroringSpawnFn(message = "spawn ENOENT"): SpawnFn {
  return () => {
    const emitter = new EventEmitter() as any;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    setTimeout(() => {
      emitter.emit("error", new Error(message));
    }, 0);
    return emitter;
  };
}

// A SpawnFn whose synchronous construction throws (e.g. bad argv).
function throwingSpawnFn(message = "boom"): SpawnFn {
  return () => {
    throw new Error(message);
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

  function enqueueDueJob() {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());
    return job;
  }

  it("backs off and re-queues (not failed) when the command errors transiently", async () => {
    const job = enqueueDueJob();
    const now = new Date();
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: erroringSpawnFn("spawn ENOENT"),
      retryPolicy: { baseBackoffMs: 60_000, maxBackoffMs: 60_000 },
    });

    const [result] = await scheduler.tick(now);
    expect(result.status).toBe("waiting_for_retry");
    expect(result.lastError).toContain("spawn ENOENT");
    // First attempt -> resetAt should be ~baseBackoffMs after `now`.
    const delay = new Date(result.resetAt!).getTime() - now.getTime();
    expect(delay).toBe(60_000);

    // The retry job is due again once its backoff window passes.
    const later = new Date(now.getTime() + 61_000);
    expect(queue.listDue(later).map((j) => j.id)).toContain(job.id);
  });

  it("also backs off when spawn throws synchronously", async () => {
    enqueueDueJob();
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: throwingSpawnFn("bad argv"),
      retryPolicy: { maxAttempts: 5 },
    });

    const [result] = await scheduler.tick();
    expect(result.status).toBe("waiting_for_retry");
    expect(result.lastError).toContain("bad argv");
  });

  it("permanently fails a job once maxAttempts is exhausted (transient failures)", async () => {
    const job = enqueueDueJob();
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: erroringSpawnFn("still broken"),
      retryPolicy: { maxAttempts: 2, baseBackoffMs: 1000, maxBackoffMs: 1000 },
    });

    // Attempt 1: backs off.
    let due = queue.listDue(new Date(Date.now() + 10_000));
    let result = (await scheduler.tick(new Date(Date.now() + 10_000)))[0];
    expect(result.status).toBe("waiting_for_retry");
    expect(result.attempts).toBe(1);

    // Attempt 2 (== maxAttempts): gives up permanently.
    due = queue.listDue(new Date(Date.now() + 20_000));
    expect(due.map((j) => j.id)).toContain(job.id);
    result = (await scheduler.tick(new Date(Date.now() + 20_000)))[0];
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(2);
    expect(result.lastError).toContain("still broken");

    // Nothing left to do afterwards.
    expect(queue.listDue(new Date(Date.now() + 30_000))).toHaveLength(0);
  });

  it("gives up instead of re-queuing when a rate limit recurs past maxAttempts", async () => {
    const job = enqueueDueJob();
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({ "claude -p continue": "Usage limit reached again. Resets in 2h." }),
      retryPolicy: { maxAttempts: 1 },
    });

    const [result] = await scheduler.tick();
    // maxAttempts is 1, so the very first re-hit exhausts the budget.
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(1);
    expect(result.lastError).toContain("Rate limit hit again");
    expect(queue.getById(job.id)!.status).toBe("failed");
  });

  it("reports a failed event to the notifier when giving up", async () => {
    enqueueDueJob();
    const events: string[] = [];
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: erroringSpawnFn("nope"),
      retryPolicy: { maxAttempts: 1 },
      notify: (p) => {
        events.push(p.event);
      },
    });

    await scheduler.tick();
    expect(events).toContain("resumed");
    expect(events).toContain("failed");
  });
});
