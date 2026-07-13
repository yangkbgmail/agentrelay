import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RelayQueue } from "../src/queue.js";
import { RelayScheduler, computeBackoffDelay, retryPolicyFromEnv } from "../src/scheduler.js";
import type { SpawnFn } from "../src/scheduler.js";
import { DEFAULT_RETRY_POLICY } from "../src/types.js";

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

// Fake ChildProcess that closes with a given non-zero exit code (a genuine failure).
function failingSpawnFn(exitCode: number, stderr = ""): SpawnFn {
  return () => {
    const emitter = new EventEmitter() as any;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    setTimeout(() => {
      if (stderr) emitter.stderr.emit("data", Buffer.from(stderr));
      emitter.emit("close", exitCode);
    }, 0);
    return emitter;
  };
}

// Fake spawn that throws synchronously, simulating an ENOENT / un-spawnable command.
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

  it("does NOT mark a job completed when the command exits non-zero -- it retries with backoff", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    const now = new Date("2026-07-13T00:00:00Z");
    queue.markWaitingForReset(job.id, new Date(now.getTime() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: failingSpawnFn(1, "boom: something crashed"),
    });

    const [result] = await scheduler.tick(now);
    // The whole point: a genuine failure is NOT reported as completed.
    expect(result.status).toBe("waiting_for_reset");
    expect(result.failureRetries).toBe(1);
    expect(result.lastError).toContain("code 1");
    // First retry is scheduled one base-delay out.
    const expected = now.getTime() + DEFAULT_RETRY_POLICY.baseDelayMs;
    expect(new Date(result.resetAt!).getTime()).toBe(expected);
  });

  it("gives up and marks a job failed after the retry policy is exhausted", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: failingSpawnFn(2),
      retryPolicy: { maxAttempts: 2, baseDelayMs: 1000, backoffFactor: 2, maxDelayMs: 60_000 },
    });

    let now = new Date("2026-07-13T00:00:00Z");
    // Attempt 1 -> retry scheduled (failureRetries 1)
    queue.markWaitingForReset(job.id, new Date(now.getTime() - 1).toISOString());
    let [r] = await scheduler.tick(now);
    expect(r.status).toBe("waiting_for_reset");
    expect(r.failureRetries).toBe(1);

    // Attempt 2 -> retry scheduled (failureRetries 2 == maxAttempts, but check is >=)
    now = new Date(r.resetAt!);
    [r] = await scheduler.tick(new Date(now.getTime() + 1));
    expect(r.status).toBe("waiting_for_reset");
    expect(r.failureRetries).toBe(2);

    // Attempt 3 -> failureRetries already at maxAttempts -> give up.
    now = new Date(r.resetAt!);
    [r] = await scheduler.tick(new Date(now.getTime() + 1));
    expect(r.status).toBe("failed");
    expect(r.lastError).toContain("gave up");
  });

  it("treats an un-spawnable command as a failure without aborting the tick", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const scheduler = new RelayScheduler({ queue, spawnFn: throwingSpawnFn() });
    const [result] = await scheduler.tick();
    expect(result.status).toBe("waiting_for_reset");
    expect(result.failureRetries).toBe(1);
    expect(result.lastError).toContain("ENOENT");
  });

  it("a rate-limit re-queue never counts against the failure-retry cap", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({ "claude -p continue": "Usage limit reached. Resets in 2h." }),
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1000, backoffFactor: 2, maxDelayMs: 60_000 },
    });

    const [result] = await scheduler.tick();
    expect(result.status).toBe("waiting_for_reset");
    // Rate-limit relays must not increment the failure counter.
    expect(result.failureRetries).toBe(0);
  });
});

describe("computeBackoffDelay", () => {
  const policy = { maxAttempts: 5, baseDelayMs: 1000, backoffFactor: 3, maxDelayMs: 20_000 };

  it("grows exponentially from the base delay", () => {
    expect(computeBackoffDelay(policy, 0)).toBe(1000);
    expect(computeBackoffDelay(policy, 1)).toBe(3000);
    expect(computeBackoffDelay(policy, 2)).toBe(9000);
  });

  it("is clamped to maxDelayMs", () => {
    expect(computeBackoffDelay(policy, 3)).toBe(20_000); // 27000 clamped
    expect(computeBackoffDelay(policy, 10)).toBe(20_000);
  });
});

describe("retryPolicyFromEnv", () => {
  it("reads recognized env vars and ignores unset/invalid ones", () => {
    const policy = retryPolicyFromEnv({
      AGENTRELAY_RETRY_MAX_ATTEMPTS: "5",
      AGENTRELAY_RETRY_BASE_MS: "2000",
      AGENTRELAY_RETRY_FACTOR: "not-a-number",
      // AGENTRELAY_RETRY_MAX_MS intentionally unset
    } as NodeJS.ProcessEnv);
    expect(policy).toEqual({ maxAttempts: 5, baseDelayMs: 2000 });
  });

  it("returns an empty override when nothing is set", () => {
    expect(retryPolicyFromEnv({} as NodeJS.ProcessEnv)).toEqual({});
  });
});
