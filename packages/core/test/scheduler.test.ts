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

// Fake ChildProcess that closes with a specific exit code (defaults to 0). A
// negative code is a sentinel meaning "throw synchronously on spawn".
function fakeSpawnWithCode(outputs: Record<string, { text?: string; code?: number }>): SpawnFn {
  return (command) => {
    const key = command.join(" ");
    const entry = outputs[key] ?? { code: 0 };
    if ((entry.code ?? 0) < 0) throw new Error(`spawn failed for ${key}`);
    const emitter = new EventEmitter() as any;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    setTimeout(() => {
      if (entry.text) emitter.stdout.emit("data", Buffer.from(entry.text));
      emitter.emit("close", entry.code ?? 0);
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

  it("re-queues with exponential backoff when the command fails transiently (non-zero exit)", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, "2026-07-12T11:00:00.000Z");

    const fixedNow = new Date("2026-07-12T12:00:00.000Z");
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnWithCode({ "claude -p continue": { text: "boom, network error", code: 1 } }),
      retryPolicy: { maxRetries: 3, backoffBaseMs: 60_000, backoffMaxMs: 3_600_000 },
      now: () => fixedNow,
    });

    const [result] = await scheduler.tick(new Date("2026-07-12T12:00:00.000Z"));
    expect(result.status).toBe("waiting_for_reset");
    expect(result.retries).toBe(1);
    // First retry waits the base delay (60s) from "now".
    expect(result.resetAt).toBe(new Date(fixedNow.getTime() + 60_000).toISOString());
    expect(result.lastError).toContain("code 1");
  });

  it("marks a job failed once the retry budget is exhausted", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    // Burn through the retry budget (maxRetries: 2) and keep it due.
    const past = new Date(Date.now() - 1000).toISOString();
    queue.markWaitingForRetry(job.id, past);
    queue.markWaitingForRetry(job.id, past);
    expect(queue.getById(job.id)?.retries).toBe(2);

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnWithCode({ "claude -p continue": { text: "still failing", code: 2 } }),
      retryPolicy: { maxRetries: 2, backoffBaseMs: 1000, backoffMaxMs: 1000 },
    });

    const [result] = await scheduler.tick();
    expect(result.status).toBe("failed");
    expect(result.lastError).toContain("gave up");
  });

  it("keeps processing other due jobs when one job's command fails to spawn", async () => {
    const bad = queue.enqueue({ project: "bad", tool: "claude-code", command: ["nope"], cwd: dir });
    const good = queue.enqueue({ project: "good", tool: "claude-code", command: ["ok"], cwd: dir });
    const past = new Date(Date.now() - 1000).toISOString();
    queue.markWaitingForReset(bad.id, past);
    queue.markWaitingForReset(good.id, past);

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnWithCode({
        nope: { code: -1 }, // throws synchronously on spawn
        ok: { text: "finished cleanly", code: 0 },
      }),
    });

    const results = await scheduler.tick();
    expect(results).toHaveLength(2);
    const byProject = Object.fromEntries(results.map((j) => [j.project, j.status]));
    expect(byProject.good).toBe("completed");
    // The failed-to-spawn job was retried (transient), not silently dropped.
    expect(byProject.bad).toBe("waiting_for_reset");
  });
});
